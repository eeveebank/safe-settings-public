const NopCommand = require('./nopcommand')

/**
 * These commands will not appear the PR dry-run comment but are added as
 * JSON in the comment source for tracking
 */
class QuietNopCommand extends NopCommand {
  constructor (pluginName, repo, endpoint, action, type) {
    super(pluginName, repo, endpoint, action, type)

    this.isQuiet = true
  }
}

module.exports = QuietNopCommand
