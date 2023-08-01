const Teams = require('./teams')
const SimpleNoopCommand = require('../simpleNoopCommand')

/**
 * Never remove teams to allow incremental adoption of safe-settings
 */
module.exports = class TeamsPartial extends Teams {
  remove (existing) {
    return Promise.resolve([
      new SimpleNoopCommand(
        `TeamsPartial: ${existing.id} is a team on ${this.repo} but is not in safe-settings.`
      )
    ])
  }
}
