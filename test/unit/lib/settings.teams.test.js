jest.mock('../../../lib/metrics', () => ({
  meteredPlugin: (_plugin, fn) => fn()
}))

const Settings = require('../../../lib/settings')

describe('Pring team review request delegation', () => {
  let settings
  let github
  let teamConfigs
  let teams

  beforeEach(() => {
    teams = [{ id: 'TEAM_ID', slug: 'team-slug', enabled: true }]
    github = {
      graphql: jest.fn().mockResolvedValue({})
    }
    github.graphql.paginate = jest.fn().mockImplementation(async () => ({
      organization: { teams: { nodes: teams } }
    }))
    const context = {
      payload: { installation: { id: 123 } },
      octokit: github,
      log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }
    settings = new Settings(false, context, { owner: 'acme' }, {
      reviewRequestDelegation: { enabled: true, algorithm: 'ROUND_ROBIN', teamMemberCount: 1 }
    })
    teamConfigs = {}
    jest.spyOn(settings, 'getTeamConfigs').mockImplementation(async () => teamConfigs)
  })

  it.each([
    [true, true, false],
    [true, false, false],
    [false, true, true],
    [false, false, false],
    [undefined, true, true],
    [undefined, false, false]
  ])('with pring=%s and policy enabled=%s, applies GitHub enabled=%s', async (pring, enabled, githubEnabled) => {
    teamConfigs['team-slug.yml'] = { reviewRequestDelegation: { enabled, pring } }

    await settings.updateOrgTeams('acme')

    expect(github.graphql).toHaveBeenCalledWith(expect.any(String), {
      input: {
        id: 'TEAM_ID',
        enabled: githubEnabled,
        algorithm: 'ROUND_ROBIN',
        teamMemberCount: 1,
        excludedTeamMemberIds: []
      }
    })
  })

  it('disables GitHub for a flag-only team file without changing the configured policy', async () => {
    teamConfigs['team-slug.yml'] = { reviewRequestDelegation: { pring: true } }
    const originalConfig = structuredClone(settings.config)

    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls[0][1].input.enabled).toBe(false)
    expect(settings.config).toEqual(originalConfig)
    expect(teamConfigs['team-slug.yml']).toEqual({ reviewRequestDelegation: { pring: true } })
  })

  it.each([
    [true, true, false],
    [true, false, true],
    [true, undefined, false],
    [false, true, false],
    [false, false, true],
    [false, undefined, true],
    [undefined, true, false],
    [undefined, false, true],
    [undefined, undefined, true]
  ])('with organization pring=%s and team pring=%s, applies GitHub enabled=%s', async (organizationPring, teamPring, githubEnabled) => {
    settings.config.reviewRequestDelegation.pring = organizationPring
    teamConfigs['team-slug.yml'] = {
      reviewRequestDelegation: {
        teamMemberCount: 2,
        ...(teamPring === undefined ? {} : { pring: teamPring })
      }
    }
    const originalConfig = structuredClone(settings.config)
    const originalTeamConfigs = structuredClone(teamConfigs)

    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls[0][1].input).toEqual(expect.objectContaining({
      enabled: githubEnabled,
      teamMemberCount: 2
    }))
    expect(settings.config).toEqual(originalConfig)
    expect(teamConfigs).toEqual(originalTeamConfigs)
  })

  it('inherits Pring from the organization when a team has no file', async () => {
    settings.config.reviewRequestDelegation.pring = true

    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls[0][1].input.enabled).toBe(false)
  })

  it('inherits Pring from the organization when a team file is empty', async () => {
    settings.config.reviewRequestDelegation.pring = true
    teamConfigs['team-slug.yml'] = {}

    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls[0][1].input.enabled).toBe(false)
  })

  it('keeps GitHub disabled during restore when Pring is inherited from the organization', async () => {
    settings.config.reviewRequestDelegation.pring = true

    await settings.updateOrgTeams('acme', 'team-slug', { enabled: false })
    await settings.updateOrgTeams('acme', 'team-slug')
    await settings.updateOrgTeams('acme', 'team-slug', { enabled: true })

    expect(github.graphql.mock.calls.map(([, { input }]) => input.enabled)).toEqual([false, false, false])
  })

  it('respects a disabled delegation policy when the team opts out of organization Pring', async () => {
    settings.config.reviewRequestDelegation.pring = true
    teamConfigs['team-slug.yml'] = { reviewRequestDelegation: { enabled: false, pring: false } }

    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls[0][1].input.enabled).toBe(false)
  })

  it('reports inherited Pring in dry-run without a mutation', async () => {
    settings.nop = true
    settings.config.reviewRequestDelegation.pring = true

    await settings.updateOrgTeams('acme')

    expect(github.graphql).not.toHaveBeenCalled()
    expect(settings.results[0].action.modifications).toEqual({ enabled: false })
  })

  it('disables GitHub without an organization delegation policy', async () => {
    delete settings.config.reviewRequestDelegation
    teamConfigs['team-slug.yml'] = { reviewRequestDelegation: { pring: true } }

    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls[0][1].input.enabled).toBe(false)
  })

  it('keeps the organization policy for a team with no team file', async () => {
    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls[0][1].input.enabled).toBe(true)
  })

  it('ignores top-level Pring flags', async () => {
    settings.config.pring = true
    teamConfigs['team-slug.yml'] = { pring: true }

    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls[0][1].input.enabled).toBe(true)
  })

  it('preserves team assignment settings while disabling GitHub', async () => {
    teamConfigs['team-slug.yml'] = {
      reviewRequestDelegation: { enabled: true, teamMemberCount: 2, notifyTeam: false, pring: true }
    }
    const originalTeamConfigs = structuredClone(teamConfigs)

    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls[0][1].input).toEqual(expect.objectContaining({
      enabled: false,
      algorithm: 'ROUND_ROBIN',
      teamMemberCount: 2,
      notifyTeam: false
    }))
    expect(teamConfigs).toEqual(originalTeamConfigs)
  })

  it('reports disabling GitHub in dry-run without a mutation', async () => {
    settings.nop = true
    teamConfigs['team-slug.yml'] = { reviewRequestDelegation: { pring: true } }

    await settings.updateOrgTeams('acme')

    expect(github.graphql).not.toHaveBeenCalled()
    expect(settings.results).toEqual([
      expect.objectContaining({
        plugin: 'ReviewRequestDelegation',
        repo: 'team-slug',
        action: expect.objectContaining({ modifications: { enabled: false } })
      })
    ])
  })

  it('does not re-enable GitHub on restore or an explicit override for a Pring team', async () => {
    teamConfigs['team-slug.yml'] = { reviewRequestDelegation: { pring: true } }

    await settings.updateOrgTeams('acme', 'team-slug', { enabled: false })
    await settings.updateOrgTeams('acme', 'team-slug')
    await settings.updateOrgTeams('acme', 'team-slug', { enabled: true })

    expect(github.graphql.mock.calls.map(([, { input }]) => input.enabled)).toEqual([false, false, false])
  })

  it('restores the configured GitHub policy when Pring is switched off', async () => {
    teamConfigs['team-slug.yml'] = { reviewRequestDelegation: { pring: true } }
    await settings.updateOrgTeams('acme')

    teams[0].enabled = false
    teamConfigs['team-slug.yml'].reviewRequestDelegation.pring = false
    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls.map(([, { input }]) => input.enabled)).toEqual([false, true])
  })

  it('still disables and restores GitHub temporarily for a non-Pring team', async () => {
    await settings.updateOrgTeams('acme', 'team-slug', { enabled: false })
    await settings.updateOrgTeams('acme', 'team-slug')

    expect(github.graphql.mock.calls.map(([, { input }]) => input.enabled)).toEqual([false, true])
  })

  it('does not update restricted teams even when Pring is enabled', async () => {
    settings.config.restrictedTeams = { exclude: ['team-slug'] }
    teamConfigs['team-slug.yml'] = { reviewRequestDelegation: { pring: true } }

    await settings.updateOrgTeams('acme')

    expect(github.graphql).not.toHaveBeenCalled()
  })

  it('only applies Pring to its team during an organization sync', async () => {
    teams.push({ id: 'OTHER_TEAM_ID', slug: 'other-team', enabled: true })
    teamConfigs['team-slug.yml'] = { reviewRequestDelegation: { pring: true } }

    await settings.updateOrgTeams('acme')

    expect(github.graphql.mock.calls.map(([, { input }]) => ({ id: input.id, enabled: input.enabled })))
      .toEqual([
        { id: 'TEAM_ID', enabled: false },
        { id: 'OTHER_TEAM_ID', enabled: true }
      ])
  })
})
