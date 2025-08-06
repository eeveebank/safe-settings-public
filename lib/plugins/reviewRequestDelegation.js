const uniq = require('lodash/uniq')
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

let allMembersPromise

const getAllMembers = (org, github, log) => {
  if (allMembersPromise) {
    return allMembersPromise
  }

  allMembersPromise = new Promise((resolve) => {
    github.paginate(github.request.endpoint.merge('GET /orgs/{org}/members', {
      org,
      per_page: 100
    }))
      .then(members => {
        resolve(members)
        setTimeout(() => {
          allMembersPromise = undefined
        }, 1000 * 60 * 30)
      })
      .catch(e => {
        log.error(e)
        allMembersPromise = undefined
        resolve([])
      })
  })

  return allMembersPromise
}

const getMemberIdFromUsername = async (org, username, github, log) => {
  if (!memberIdMap.has(username)) {
    const members = await getAllMembers(org, github, log)

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

    // Required by ErrorStash
    this.repo = {
      owner: team.owner,
      repo: team.slug
    }
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

    if (this.nop) {
      const changes = this.mergeDeep.compareDeep(entry, comparableAttrs)

      if (changes.hasChanges) {
        return Promise.resolve([
          new NopCommand(this.constructor.name, {
            repo: slug,
            owner
          }, undefined, changes)
        ])
      }

      return Promise.resolve()
    }

    return this.update(slug, entry, safeAttrs)
  }

  async update (slug, existing, attrs) {
    const params = {
      id: existing.id,
      enabled: existing.enabled,
      ...attrs
    }

    const excludedTeamMembers = uniq(params.excludedTeamMembers ?? [])
    const excludedTeamMemberIds =
      await Promise.all((excludedTeamMembers)
        .map(username => getMemberIdFromUsername(this.team.owner, username, this.github, this.log)))

    const unfoundUsernames =
      excludedTeamMemberIds
        .map((id, index) => id === null ? excludedTeamMembers[index] : undefined)
        .filter(Boolean)

    // If we couldn't find the node_id for any user for whatever reason, we shouldn't update the delegation settings
    // as an existing valid exclusion may be removed.
    if (unfoundUsernames.length) {
      const error = new Error(`Could not find node_id for users: ${unfoundUsernames.join(', ')}`)
      this.handleError(error, undefined, slug)
      return
    }

    const input = {
      ...params,
      excludedTeamMemberIds
    }

    delete input.excludedTeamMembers

    this.log.info(`Updating reviewRequestDelegation for ${slug} with ${JSON.stringify(input, null, 2)}`)

    return meteredPlugin(this, () => this.github.graphql(updateTeamReviewAssignment, {
      input
    }).then(res => {
      this.log(`reviewRequestDelegation for  ${slug} updated successfully ${JSON.stringify(res)}`)
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
