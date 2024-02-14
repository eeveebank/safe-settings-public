const Collaborators = require('../../../../lib/plugins/collaboratorsPartial')
const NopCommand = require('../../../../lib/nopcommand')

jest.mock('../../../../lib/nopcommand')

describe('CollaboratorsPartial', () => {
  const github = {
    repos: {
      listInvitations: jest.fn().mockResolvedValue([]),
      deleteInvitation: jest.fn().mockResolvedValue(),
      updateInvitation: jest.fn().mockResolvedValue(),
      listCollaborators: jest.fn().mockResolvedValue([]),
      removeCollaborator: jest.fn().mockResolvedValue(),
      addCollaborator: jest.fn().mockResolvedValue()
    }
  }

  function configure (config, noop = false) {
    const log = { debug: jest.fn(), error: console.error }
    return new Collaborators(noop, github, { owner: 'bkeepers', repo: 'test' }, config, log)
  }

  describe('sync', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('syncs collaborators', () => {
      const plugin = configure([
        { username: 'bkeepers', permission: 'admin' },
        { username: 'added-user', permission: 'push' },
        { username: 'updated-permission', permission: 'push' },
        { username: 'DIFFERENTcase', permission: 'push' }
      ])

      github.repos.listCollaborators.mockResolvedValueOnce({
        data: [
          { login: 'bkeepers', permissions: { admin: true, push: true, pull: true } },
          { login: 'updated-permission', permissions: { admin: false, push: false, pull: true } },
          { login: 'removed-user', permissions: { admin: false, push: true, pull: true } },
          { login: 'differentCase', permissions: { admin: false, push: true, pull: true } }
        ]
      })

      return plugin.sync().then(() => {
        expect(github.repos.addCollaborator).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          username: 'added-user',
          permission: 'push'
        })

        expect(github.repos.addCollaborator).toHaveBeenCalledWith({
          owner: 'bkeepers',
          repo: 'test',
          username: 'updated-permission',
          permission: 'push'
        })

        expect(github.repos.addCollaborator).toHaveBeenCalledTimes(2)

        expect(github.repos.removeCollaborator).not.toHaveBeenCalled()
      })
    })
  })

  describe('noop run', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('doesnt add deletions in summaries', async () => {
      const plugin = configure([
        { username: 'bkeepers', permission: 'admin' },
        { username: 'added-user', permission: 'push' },
        { username: 'updated-permission', permission: 'push' },
      ], true)

      github.repos.listCollaborators.mockResolvedValueOnce({
        data: [
          { login: 'bkeepers', permissions: { admin: true, push: true, pull: true } },
          { login: 'removed-user', permissions: { admin: false, push: true, pull: true } },
          { login: 'updated-permission', permissions: { admin: false, push: false, pull: true } },
          { login: 'removed-user', permissions: { admin: false, push: true, pull: true } },
        ]
      })

      await plugin.sync()

      expect(NopCommand).toHaveBeenCalledWith(
        'CollaboratorsPartial',
        { owner: 'bkeepers', repo: 'test' },
        null,
        expect.objectContaining({
          deletions: {}
        }),
        'INFO',
      );
    })
  })

  it('doesnt add summary if no additions/modifications', async () => {
    const plugin = configure([
      { username: 'bkeepers', permission: 'admin' },
    ], true)

    github.repos.listCollaborators.mockResolvedValueOnce({
      data: [
        { login: 'bkeepers', permissions: { admin: true, push: true, pull: true } },
        { login: 'removed-user', permissions: { admin: false, push: true, pull: true } },
      ]
    })

    expect(await plugin.sync()).toBe(undefined)
  })
})
