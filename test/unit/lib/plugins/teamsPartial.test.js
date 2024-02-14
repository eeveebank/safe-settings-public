const { when } = require('jest-when')
const any = require('@travi/any')
const Teams = require('../../../../lib/plugins/teamsPartial')
const NopCommand = require('../../../../lib/nopcommand')

jest.mock('../../../../lib/nopcommand')

describe('TeamsPartial', () => {
  let github
  const addedTeamName = 'added'
  const addedTeamId = any.integer()
  const updatedTeamName = 'updated-permission'
  const updatedTeamId = any.integer()
  const removedTeamName = 'removed'
  const removedTeamId = any.integer()
  const unchangedTeamName = 'unchanged'
  const unchangedTeamId = any.integer()
  const org = 'bkeepers'

  function configure (config, noop = false) {
    const log = { debug: jest.fn(), error: console.error }
    return new Teams(noop, github, { owner: 'bkeepers', repo: 'test' }, config, log)
  }

  beforeEach(() => {
    jest.clearAllMocks()
    github = {
      paginate: jest.fn()
        .mockResolvedValue()
        .mockImplementation(async (fetch) => {
          const response = await fetch()
          return response.data
        }),
      teams: {
        getByName: jest.fn(),
        addOrUpdateRepoPermissionsInOrg: jest.fn().mockResolvedValue()
      },
      repos: {
        listTeams: jest.fn().mockResolvedValue({
          data: [
            { id: unchangedTeamId, slug: unchangedTeamName, name: unchangedTeamName, permission: 'push' },
            { id: removedTeamId, slug: removedTeamName, name: removedTeamName, permission: 'push' },
            { id: updatedTeamId, slug: updatedTeamName, name: updatedTeamName, permission: 'pull' }
          ]
        })
      },
      request: jest.fn()
    }
  })

  describe('sync', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('syncs teams', async () => {
      const plugin = configure([
        { name: unchangedTeamName, permission: 'push' },
        { name: updatedTeamName, permission: 'admin' },
        { name: addedTeamName, permission: 'pull' }
      ])

      when(github.teams.getByName)
        .defaultResolvedValue({})
        .calledWith({ org: 'bkeepers', team_slug: addedTeamName })
        .mockResolvedValue({ data: { id: addedTeamId } })

      await plugin.sync()

      expect(github.request).toHaveBeenCalledWith(
        'PUT /orgs/:owner/teams/:team_slug/repos/:owner/:repo',
        {
          org,
          owner: org,
          repo: 'test',
          team_id: updatedTeamId,
          team_slug: updatedTeamName,
          permission: 'admin'
        }
      )

      expect(github.teams.addOrUpdateRepoPermissionsInOrg).toHaveBeenCalledWith({
        org,
        team_id: addedTeamId,
        team_slug: addedTeamName,
        owner: org,
        repo: 'test',
        permission: 'pull'
      })

      expectTeamNotDeleted(removedTeamName)
    })

    function expectTeamNotDeleted() {
      expect(github.request).not.toHaveBeenCalledWith(
        'DELETE /orgs/:owner/teams/:team_slug/repos/:owner/:repo',
        expect.any(Object)
      )
    }
  })

  describe('noop', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('doesnt add deletions in summaries', async () => {
      const plugin = configure([
        { name: unchangedTeamName, permission: 'push' },
        { name: updatedTeamName, permission: 'pull' },
        { name: addedTeamName, permission: 'pull' }
      ], true)

      await plugin.sync()

      expect(NopCommand).toHaveBeenCalledWith(
        'TeamsPartial',
        { owner: 'bkeepers', repo: 'test' },
        null,
        expect.objectContaining({
          deletions: {},
        }),
        'INFO'
      );
    })

    it('doesnt add summary if no additions/modifications', async () => {
      const plugin = configure([
        { name: unchangedTeamName, permission: 'push' },
        { name: updatedTeamName, permission: 'pull' }
      ], true)

      expect(await plugin.sync()).toBe(undefined)
    })
  })
})
