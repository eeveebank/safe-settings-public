const { execFileSync } = require('node:child_process')
const path = require('node:path')

// Use real Node module loading, not Jest's CommonJS-only dependency transform.
// An explicit environment keeps these offline checks independent of app secrets.
function runOffline (source) {
  execFileSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '../..'),
    env: { NODE_ENV: 'test' },
    timeout: 20000,
    stdio: 'pipe'
  })
}

describe('Lambda dependency compatibility', () => {
  it('keeps every installed OpenTelemetry core at a patched version', () => {
    const { packages } = require('../../package-lock.json')
    const cores = Object.entries(packages)
      .filter(([name]) => name.endsWith('node_modules/@opentelemetry/core'))

    expect(cores.length).toBeGreaterThan(0)
    for (const [, { version }] of cores) {
      const [major, minor] = version.split('.').map(Number)
      expect(major > 2 || (major === 2 && minor >= 8)).toBe(true)
    }
  })

  it('formats logs and captures scoped errors with the real Sentry SDK', () => {
    runOffline(`
      const assert = require('node:assert/strict')
      const { createRequire } = require('node:module')
      const adapterRequire = createRequire(require.resolve('@probot/adapter-aws-lambda-serverless'))
      const probotRequire = createRequire(adapterRequire.resolve('probot'))
      const loggerRequire = createRequire(probotRequire.resolve('@probot/pino'))
      const Sentry = loggerRequire('@sentry/node')
      const envelopes = []
      const init = Sentry.init
      // Only replace the network transport; init, scopes and capture are real.
      Sentry.init = options => init({
        ...options,
        transport: () => ({
          send: async envelope => { envelopes.push(envelope); return { statusCode: 200 } },
          flush: async () => true
        })
      })
      const getTransformStream = probotRequire('@probot/pino')

      ;(async () => {
        const plain = getTransformStream({ logFormat: 'json', logLevelInString: true })
        let plainOutput = ''
        plain.on('data', chunk => { plainOutput += chunk })
        plain.write(JSON.stringify({ level: 30, msg: 'plain log' }))
        plain.end()
        assert.equal(JSON.parse(plainOutput).level, 'info')

        const stream = getTransformStream({
          logFormat: 'json',
          sentryDsn: 'https://public@example.invalid/1'
        })
        const output = []
        stream.on('data', chunk => output.push(JSON.parse(chunk)))
        stream.write(JSON.stringify({ level: 30, msg: 'info log' }))
        for (const level of [50, 60]) {
          stream.write(JSON.stringify({
            level, msg: 'test error ' + level, type: 'LambdaError', status: 500,
            headers: { 'x-test': 'offline' },
            request: { method: 'POST', url: '/webhooks', body: 'not retained' },
            event: { id: 'delivery-' + level, payload: { installation: { id: 123, account: { login: 'test-org' } } } }
          }))
        }
        stream.end()
        assert.equal(await Sentry.flush(5000), true)
        assert.equal(output.length, 3)
        assert.equal(output[0].msg, 'info log')
        const events = envelopes.flatMap(([, items]) => items)
          .filter(([header]) => header.type === 'event').map(([, event]) => event)
        assert.equal(events.length, 2)
        for (const [index, level] of [50, 60].entries()) {
          const event = events[index]
          assert.equal(event.level, level === 50 ? 'error' : 'fatal')
          assert.equal(event.user.id, 123)
          assert.equal(event.user.username, 'test-org')
          assert.equal(event.extra.status, 500)
          assert.equal(event.extra.headers['x-test'], 'offline')
          assert.equal(event.exception.values[0].type, 'LambdaError')
          assert.equal(output[index + 1].sentryEventId, event.event_id)
          assert.deepEqual(output[index + 1].event, { id: 'delivery-' + level })
          assert.deepEqual(output[index + 1].request, { method: 'POST', url: '/webhooks' })
        }
        await Sentry.close(5000)
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `)
  })

  it('runs the existing adapter with its real Probot 13 and logger', () => {
    runOffline(`
      const assert = require('node:assert/strict')
      const { createHmac } = require('node:crypto')
      const { Probot, createLambdaFunction } = require('@probot/adapter-aws-lambda-serverless')

      ;(async () => {
        const secret = 'offline-test-secret'
        const probot = new Probot({ githubToken: 'offline-test-token', secret, logLevel: 'fatal' })
        assert.equal(probot.version.split('.')[0], '13')
        let received = 0
        const handler = createLambdaFunction(app => {
          app.on('ping', () => { received++ })
        }, { probot })
        assert.equal((await handler({ httpMethod: 'GET', path: '/probot' })).statusCode, 200)
        const body = JSON.stringify({ zen: 'offline test' })
        const event = {
          httpMethod: 'POST', path: '/webhooks', body,
          headers: {
            'X-GitHub-Delivery': 'offline-delivery', 'X-GitHub-Event': 'ping',
            'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
          }
        }
        assert.deepEqual(await handler(event), { statusCode: 200, body: JSON.stringify({ ok: true }) })
        assert.equal(received, 1)
        await assert.rejects(handler({ ...event, body: '{}' }))
        assert.equal(received, 1)
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `)
  })
})
