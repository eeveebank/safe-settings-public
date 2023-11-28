const metrics = require("@operate-first/probot-metrics");

const counter = metrics.useCounter({
  name: 'num_of_actions_total',
  help: 'Total number of actions received',
  labelNames: ['repository', 'result', 'action'],
});

const meteredPlugin = async (plugin, fn) => {
  try {
    const result = await fn()
    counter
      .labels({
        repository: plugin.repo.repo,
        result: "success",
        action: plugin.constructor.name
      })
      .inc();
    return result
  } catch (e) {
    console.dir(e)
    counter
      .labels({
        repository: plugin.repo.repo,
        result: "error",
        action: plugin.constructor.name
      })
      .inc();
    throw e;
  }
}

module.exports = {meteredPlugin}
