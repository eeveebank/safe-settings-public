const metrics = require("@operate-first/probot-metrics");

module.exports =  metrics.useCounter({
    name: 'num_of_actions_total',
    help: 'Total number of actions received',
    labelNames: ['repository', 'result'],
});
