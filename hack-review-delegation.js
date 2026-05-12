const ConfigManager = require('./lib/configManager')
const Settings = require('./lib/settings')

const restoreTimeouts = new Map()

const sendJson = (response, statusCode, payload) => {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}

const readJsonBody = (request) => new Promise((resolve, reject) => {
  const chunks = []

  request.on('data', chunk => {
    chunks.push(chunk)
  })

  request.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8')
      resolve(raw ? JSON.parse(raw) : {})
    } catch (error) {
      reject(error)
    }
  })

  request.on('error', reject)
})

/**
 * Temporary mega hack to disable review delegation for a team and restore it after a specified time.
 * Route to be called from a workflow before creating an automerged PR.
 */
const addDisableReviewDelegationRoute = (robot, addHandler, loadYamlFileSystem) => {
  addHandler(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')

    if (request.method !== 'POST' || url.pathname !== '/api/disable-review-delegation') {
      return
    }

    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      robot.log.error(error)
      return sendJson(response, 400, { error: 'Request body must be valid JSON.' })
    }

    const { teamSlug, restoreSeconds } = body
    const restoreDelaySeconds = Number(restoreSeconds)

    if (!teamSlug || !Number.isFinite(restoreDelaySeconds) || restoreDelaySeconds <= 0) {
      return sendJson(response, 400, { error: 'teamSlug and restoreSeconds are required.' })
    }

    try {
      let github = await robot.auth()

      const installations = await github.paginate(
        github.rest.apps.listInstallations.endpoint.merge({ per_page: 100 })
      )

      if (!installations.length) {
        return sendJson(response, 500, { message: 'App installation not found.' })
      }

      const installation = installations[0]
      github = await robot.auth(installation.id)
      const context = {
        payload: {
          installation
        },
        octokit: github,
        log: robot.log,
        repo: () => ({ repo: undefined, owner: installation.account.login })
      }
      const deploymentConfig = await loadYamlFileSystem()
      const configManager = new ConfigManager(context)
      const runtimeConfig = await configManager.loadGlobalSettingsYaml()
      const config = Object.assign({}, deploymentConfig, runtimeConfig)
      const settings = new Settings(false, context, context.repo(), config)
      await settings.updateOrgTeams(installation.account.login, teamSlug, {
        enabled: false
      })
      robot.log.info(`Review delegation disabled for team: ${teamSlug} for seconds: ${restoreDelaySeconds}`)

      const existingTimeout = restoreTimeouts.get(teamSlug)
      if (existingTimeout) {
        robot.log.info(`Clearing previously scheduled restore delegation for team: ${teamSlug} in org: ${installation.account.login}`)
        clearTimeout(existingTimeout)
        restoreTimeouts.delete(teamSlug)
      }

      const restoreTimeout = setTimeout(async () => {
        robot.log.info(`Restoring review delegation for team: ${teamSlug}`)
        await settings.updateOrgTeams(installation.account.login, teamSlug)
        restoreTimeouts.delete(teamSlug)
      }, restoreDelaySeconds * 1000)

      restoreTimeouts.set(teamSlug, restoreTimeout)

      return sendJson(response, 200, { message: 'Review delegation disabled' })
    } catch (error) {
      robot.log.error(error)
      return sendJson(response, 500, { error: 'Failed to disable review delegation.' })
    }
  })
}

module.exports = {
  addDisableReviewDelegationRoute
}
