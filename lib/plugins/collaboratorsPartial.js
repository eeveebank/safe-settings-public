const Collaborators = require('./collaborators')
const QuietNopCommand = require('../quietNopCommand')

/**
 * Never remove collaborators to allow incremental adoption of safe-settings
 */
module.exports = class CollaboratorsPartial extends Collaborators {
  constructor (...args) {
    super(...args)

    this.isPartialSync = true
  }

  remove (existing) {
    return Promise.resolve([
      new QuietNopCommand(this.constructor.name, this.repo, {
        url: '[no-endpoint-called]',
        body: {
          username: existing.username,
          permission: existing.permission
        }
      }, 'NOOP: Remove collaborator')
    ])
  }
}
