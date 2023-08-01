const Collaborators = require('./collaborators')
const NopCommand = require('../nopcommand')

/**
 * Never remove collaborators to allow incremental adoption of safe-settings
 */
module.exports = class CollaboratorsPartial extends Collaborators {
  remove (existing) {
    return Promise.resolve([
      new NopCommand(this.constructor.name, this.repo, {
        url: '[no-endpoint-called]',
        body: existing
      }, 'NOOP: Remove collaborator')
    ])
  }
}
