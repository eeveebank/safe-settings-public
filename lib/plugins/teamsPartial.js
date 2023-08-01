const Teams = require('./teams')
const NopCommand = require('../nopcommand')

/**
 * Never remove teams to allow incremental adoption of safe-settings
 */
module.exports = class TeamsPartial extends Teams {
  remove (existing) {
    return Promise.resolve([
      new NopCommand(this.constructor.name, this.repo, {
        url: '[no-endpoint-called]',
        body: existing
      }, 'NOOP: Remove team')
    ])
  }
}
