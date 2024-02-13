const Teams = require('./teams')
const QuietNopCommand = require('../quietNopCommand')

/**
 * Never remove teams to allow incremental adoption of safe-settings
 */
module.exports = class TeamsPartial extends Teams {
  constructor (...args) {
    super(...args)

    this.isPartialSync = true
  }

  remove (existing) {
    return Promise.resolve([
      new QuietNopCommand(this.constructor.name, this.repo, {
        url: '[no-endpoint-called]',
        body: {
          name: existing.name,
          permission: existing.permission
        }
      }, 'NOOP: Remove team')
    ])
  }
}
