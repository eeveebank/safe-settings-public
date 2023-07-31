class SimpleNoopCommand {
  constructor (message) {
    this.message = message
  }

  toString () {
    return `SimpleNoopCommand: ${this.message}`
  }
}

module.exports = SimpleNoopCommand
