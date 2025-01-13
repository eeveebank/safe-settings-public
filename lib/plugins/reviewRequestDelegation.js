const NopCommand = require('../nopcommand')
const MergeDeep = require('../mergeDeep')
const { meteredPlugin } = require('../metrics')
const ErrorStash = require('./errorStash')

const updateTeamReviewAssignment = `
  mutation updateTeamReviewAssignment(
    $input: UpdateTeamReviewAssignmentInput!
  ) {
    updateTeamReviewAssignment(input: $input) {
      clientMutationId
    }
  }
`

const requestDelegationsQuery = `
  query paginate($cursor: String, $org: String!) {
    organization(
      login: $org
    ) {
      teams(first: 100, after: $cursor) {
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          id
          slug
          enabled: reviewRequestDelegationEnabled
          algorithm: reviewRequestDelegationAlgorithm
          teamMemberCount: reviewRequestDelegationMemberCount
          notifyTeam: reviewRequestDelegationNotifyTeam
        }
      }
    }
  }
`

// These are readable from the API so can be used in the diff
const comparableProperties = [
  'enabled',
  'algorithm',
  'teamMemberCount',
  'notifyTeam'
]

const properties = [
  ...comparableProperties,
  'countMembersAlreadyRequested',
  'includeChildTeamMembers',
  'removeTeamRequest',
  'excludedTeamMembers'
]

const memberIdMap = new Map()

const getMemberIdFromUsername = async (org, username, github, log) => {
  const listOptions = github.request.endpoint.merge('GET /orgs/{org}/members', {
    org,
    per_page: 100
  })

  if (!memberIdMap.has(username)) {
    const members = await github.paginate(listOptions)
      .catch(e => {
        log.error(e)
        return []
      })

    members.forEach(member => {
      memberIdMap.set(member.login, member.node_id)
    })
  }

  if (!memberIdMap.has(username)) {
    log.warn(`Could not find member with login: ${username}`)
    return null
  }

  return memberIdMap.get(username)
}

module.exports = class ReviewRequestDelegation extends ErrorStash {
  constructor (nop, github, team, config, log, errors) {
    super(errors)

    this.github = github
    this.team = team
    this.config = config
    this.log = log
    this.nop = nop
    this.mergeDeep = new MergeDeep(log, github, [])
  }

  static async find (github, org, filter) {
    if (!github.graphql.paginate) {
      const { paginateGraphQL } = await import('@octokit/plugin-paginate-graphql')
      paginateGraphQL(github)
    }

    const teamsData = await github.graphql.paginate(requestDelegationsQuery, {
      org
    })

    return teamsData.organization.teams.nodes
      .filter(filter)
  }

  sync (entry) {
    const { slug, owner } = this.team
    const teamConfig = this.config

    if (!teamConfig) {
      return Promise.resolve()
    }

    const safeAttrs = {}
    const comparableAttrs = {}
    Object.keys(teamConfig).forEach(key => {
      if (properties.includes(key)) {
        safeAttrs[key] = teamConfig[key]
      }
      if (comparableProperties.includes(key)) {
        comparableAttrs[key] = teamConfig[key]
      }
    })

    const changes = this.mergeDeep.compareDeep(entry, comparableAttrs)

    if (changes.hasChanges) {
      if (this.nop) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, {
            repo: slug,
            owner
          }, undefined, changes)
        ])
      }

      return this.update(slug, entry, safeAttrs)
    }

    return Promise.resolve()
  }

  async update (slug, existing, attrs) {
    const params = {
      id: existing.id,
      enabled: existing.enabled,
      ...attrs
    }

    const input = {
      ...params,
      excludedTeamMemberIds: (
        await Promise.all((params.excludedTeamMembers ?? [])
          .map(username => getMemberIdFromUsername(this.org, username, this.github, this.log))))
        .filter(Boolean)
    }

    delete input.excludedTeamMembers

    this.log.info(`Updating reviewRequestDelegation with ${JSON.stringify(input, null, 2)}`)

    return meteredPlugin(this, () => this.github.graphql(updateTeamReviewAssignment, {
      input
    }).then(res => {
      this.log(`reviewRequestDelegation updated successfully ${JSON.stringify(res)}`)
      return res
    }).catch(e => {
      return this.handleError(e, undefined, slug)
    }))
  }

  handleError (e, returnValue, slug) {
    this.logError(e)
    if (this.nop) {
      return Promise.resolve([(new NopCommand(this.constructor.name, {
        repo: slug
      }, null, `error: ${e}`, 'ERROR'))])
    }
    return Promise.resolve(returnValue)
  }
}
