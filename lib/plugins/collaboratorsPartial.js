const Collaborators = require('./collaborators')
const SimpleNoopCommand = require('../simpleNoopCommand')

/**
 * Never remove collaborators to allow incremental adoption of safe-settings
 */
module.exports = class CollaboratorsPartial extends Collaborators {
  remove (existing) {
    return Promise.resolve([
      new SimpleNoopCommand(
        `CollaboratorsPartial: ${existing.username} is a collaborator on ${this.repo} but is not in safe-settings.`
      )
    ])
  }
}
