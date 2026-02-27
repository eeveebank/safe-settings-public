describe('ReviewRequestDelegation', () => {
  let ReviewRequestDelegation
  let github
  let log

  beforeEach(() => {
    jest.resetModules()
    jest.doMock('@operate-first/probot-metrics', () => ({
      useCounter: () => ({ labels: () => ({ inc: jest.fn() }) })
    }))
    ReviewRequestDelegation = require('../../../../lib/plugins/reviewRequestDelegation')
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    github = {
      paginate: jest.fn().mockResolvedValue([
        { login: 'valid-user', node_id: 'NODE_ID' }
      ]),
      request: {
        endpoint: {
          merge: jest.fn()
        }
      },
      graphql: jest.fn().mockResolvedValue({})
    }
  })

  it('skips missing excludedTeamMembers while updating', async () => {
    const plugin = new ReviewRequestDelegation(
      false,
      github,
      { owner: 'acme', slug: 'team-slug' },
      { excludedTeamMembers: ['valid-user', 'missing-user'] },
      log,
      []
    )

    await plugin.sync({ id: 'TEAM_ID', enabled: true })

    expect(log.warn).toHaveBeenCalledWith(
      'Skipping missing excludedTeamMembers for team-slug: missing-user'
    )

    expect(github.graphql).toHaveBeenCalledWith(
      expect.any(String),
      {
        input: expect.objectContaining({
          id: 'TEAM_ID',
          enabled: true,
          excludedTeamMemberIds: ['NODE_ID']
        })
      }
    )

    const { input } = github.graphql.mock.calls[0][1]
    expect(input.excludedTeamMembers).toBeUndefined()
  })

  it('does not update when member lookup fails', async () => {
    github.paginate.mockRejectedValueOnce(new Error('boom'))

    const plugin = new ReviewRequestDelegation(
      false,
      github,
      { owner: 'acme', slug: 'team-slug' },
      { excludedTeamMembers: ['valid-user'] },
      log,
      []
    )

    await plugin.sync({ id: 'TEAM_ID', enabled: true })

    expect(github.graphql).not.toHaveBeenCalled()
  })
})
