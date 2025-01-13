const metrics = require("@operate-first/probot-metrics");

const actionCounter = metrics.useCounter({
  name: 'num_of_actions_total',
  help: 'Total number of actions received',
  labelNames: ['repository', 'team', 'result', 'action', 'nop'],
});

const meteredPlugin = async (plugin, fn) => {
  try {
    const result = await fn()
    actionCounter
      .labels({
        repository: plugin.repo?.repo,
        team: plugin.team?.slug,
        nop: plugin.nop,
        result: "success",
        action: plugin.constructor.name
      })
      .inc();
    return result
  } catch (e) {
    console.dir(e)
    actionCounter
      .labels({
        repository: plugin.repo?.repo,
        team: plugin.team?.slug,
        result: "error",
        nop: plugin.nop,
        action: plugin.constructor.name
      })
      .inc();
    throw e;
  }
}

const syncStartCounter = metrics.useCounter({
  name: 'sync_start_count',
  help: 'Number of sync start events',
  labelNames: ['nop', 'type', 'name']
})

const syncEndCounter = metrics.useCounter({
  name: 'sync_end_count',
  help: 'Number of sync end events',
  labelNames: ['nop', 'type', 'status', 'name']
})

/**
 * @typedef {"all" | "suborg" | "repo"} SyncType
 */

/**
 * Increase sync start counter
 *
 * @param {boolean} nop Is dry run on PR?
 * @param {SyncType} type Type of sync
 * @param {string | undefined} name Name of suborg or repo
 * @returns
 */
const syncStart = (nop, type, name) => {
  if (name) {
    syncStartCounter.inc({
      nop,
      type,
      name
    })
    return
  }

  syncStartCounter.inc({
    nop,
    type
  })
}

/**
 * Increase sync end counter
 *
 * @param {boolean} nop Is dry run on PR?
 * @param {SyncType} type Type of sync
 * @param {boolean} hasError At least one error occurred
 * @param {boolean} hasException An exception potentially prevented syncing subsequent settings
 * @param {string | undefined} name Name of suborg or repo
 * @returns
 */
const syncEnd = (nop, type, hasException, hasError, name) => {
  const status = hasException ? 'fail' : hasError ? 'error' : 'ok'

  if (name) {
    syncEndCounter.inc({
      nop,
      type,
      status,
      name
    })
    return
  }

  syncEndCounter.inc({
    nop,
    type,
    status
  })
}

module.exports = {
  meteredPlugin,
  syncStart,
  syncEnd
}
