// Inlined from https://github.com/operate-first/probot-extensions/blob/268a126189a93b526b6af688270fea1fa012afff/packages/probot-metrics/index.ts
// as unmaintained and incompatible with probot 14

const promClient = require('prom-client')

const PREFIX = 'probot_'

if (process.env.NODE_ENV === 'production') {
  promClient.register.clear()
  promClient.collectDefaultMetrics({ prefix: PREFIX })
}

const useCounter = (
  options
) => {
  const name = PREFIX + options.name
  try {
    return new promClient.Counter({ ...options, name })
  } catch {
    return promClient.register.getSingleMetric(
      name
    )
  }
}

const useGauge = (options) => {
  const name = PREFIX + options.name
  try {
    return new promClient.Gauge({ ...options, name })
  } catch {
    return promClient.register.getSingleMetric(
      name
    )
  }
}

const useHistogram = (
  options
) => {
  const name = PREFIX + options.name
  try {
    return new promClient.Histogram({ ...options, name })
  } catch {
    return promClient.register.getSingleMetric(
      name
    )
  }
}

const useSummary = (
  options
) => {
  const name = PREFIX + options.name
  try {
    return new promClient.Summary({ ...options, name })
  } catch {
    return promClient.register.getSingleMetric(
      name
    )
  }
}

const exposeMetrics = (addHandler, route = '/metrics') => {
  addHandler(async (request, response) => {
    if (request.url !== route) {
      return
    }

    response.setHeader('Content-type', promClient.register.contentType)
    response.end(await promClient.register.metrics())
  })
}

module.exports = {
  useCounter,
  useGauge,
  useHistogram,
  useSummary,
  exposeMetrics
}
