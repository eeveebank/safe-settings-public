
const path = require('path')
const { Eta } = require('eta')
const commetMessageTemplate = require('./commentmessage')
const errorTemplate = require('./error')
const Glob = require('./glob')
const NopCommand = require('./nopcommand')
const MergeDeep = require('./mergeDeep')
const Archive = require('./plugins/archive')
const env = require('./env')
const { meteredPlugin, syncStart, syncEnd } = require('./metrics')
const ReviewRequestDelegation = require('./plugins/reviewRequestDelegation')

const CONFIG_PATH = env.CONFIG_PATH
const eta = new Eta({ views: path.join(__dirname) })
const SCOPE = { ORG: 'org', REPO: 'repo' } // Determine if the setting is a org setting or repo setting
const yaml = require('js-yaml');

class Settings {
  static fileCache = {};

  static async syncAll (nop, context, repo, config, ref) {
    syncStart(nop, 'all')
    const settings = new Settings(nop, context, repo, config, ref)
    try {
      await settings.loadConfigs()
      // settings.repoConfigs = await settings.getRepoConfigs()
      await settings.updateOrg()
      await settings.updateOrgTeams(repo.owner)
      await settings.updateAll()
      await settings.handleResults()
      syncEnd(nop, 'all', false, settings.hasError())
    } catch (error) {
      syncEnd(nop, 'all', true, true)
      settings.logError(error.message)
      await settings.handleResults()
    }
    return settings
  }

  static async syncSubOrgs (nop, context, suborg, repo, config, ref) {
    syncStart(nop, 'suborg', suborg)
    const settings = new Settings(nop, context, repo, config, ref, suborg)
    try {
      await settings.loadConfigs()
      await settings.updateAll()
      await settings.handleResults()
      syncStart(nop, 'suborg', false, settings.hasError(), suborg)
    } catch (error) {
      syncEnd(nop, 'suborg', true, true, suborg)
      settings.logError(error.message)
      await settings.handleResults()
    }
  }

  static async sync (nop, context, repo, config, ref) {
    syncStart(nop, 'repo', repo?.repo)
    const settings = new Settings(nop, context, repo, config, ref)
    try {
      await settings.loadConfigs(repo)
      if (settings.isRestricted(repo.repo)) {
        syncEnd(nop, 'repo', false, false, repo?.repo)
        return
      }
      await settings.updateRepos(repo)
      await settings.handleResults()
      syncEnd(nop, 'repo', false, settings.hasError(), repo?.repo)
    } catch (error) {
      syncEnd(nop, 'repo', true, true, repo?.repo)
      settings.logError(error.message)
      await settings.handleResults()
    }
  }

  static async syncTeams (nop, context, repo, config, ref) {
    syncStart(nop, 'teams')
    const settings = new Settings(nop, context, repo, config, ref)
    try {
      await settings.updateOrgTeams(repo.owner, repo.team)
      await settings.handleResults()
      syncEnd(nop, 'teams', false, settings.hasError())
    } catch (error) {
      syncEnd(nop, 'teams', true, true)
      settings.logError(error.message)
      await settings.handleResults()
    }
  }

  static async handleError (nop, context, repo, config, ref, nopcommand) {
    const settings = new Settings(nop, context, repo, config, ref)
    settings.appendToResults([nopcommand])
    await settings.handleResults()
  }

  constructor (nop, context, repo, config, ref, suborg) {
    this.ref = ref
    this.context = context
    this.installation_id = context.payload.installation.id
    this.github = context.octokit
    this.repo = repo
    this.config = config
    this.nop = nop
    this.suborgChange = !!suborg
    // If suborg config has been updated, do not load the entire suborg config, and only process repos restricted to it.
    if (suborg) {
      this.subOrgConfigMap = [suborg]
    }
    this.log = context.log
    this.results = []
    this.errors = []
    this.configvalidators = {}
    this.overridevalidators = {}
    const overridevalidators = config.overridevalidators
    if (this.isIterable(overridevalidators)) {
      for (const validator of overridevalidators) {
        // eslint-disable-next-line no-new-func
        const f = new Function('baseconfig', 'overrideconfig', 'githubContext', validator.script)
        this.overridevalidators[validator.plugin] = { canOverride: f, error: validator.error }
      }
    }
    const configvalidators = config.configvalidators
    if (this.isIterable(configvalidators)) {
      for (const validator of configvalidators) {
        this.log.debug(`Logging each script: ${typeof validator.script}`)
        // eslint-disable-next-line no-new-func
        const f = new Function('baseconfig', 'githubContext', validator.script)
        this.configvalidators[validator.plugin] = { isValid: f, error: validator.error }
      }
    }
    this.mergeDeep = new MergeDeep(this.log, this.github, [], this.configvalidators, this.overridevalidators)
  }

  // Create a check in the Admin repo for safe-settings.
  async createCheckRun () {
    const startTime = new Date()
    let conclusion = 'success'
    let details = `Run on: \`${new Date().toISOString()}\``
    let summary = 'Safe-Settings finished successfully.'

    if (this.errors.length > 0) {
      conclusion = 'failure'
      summary = 'Safe-Settings finished with errors.'
      details = await eta.renderString(errorTemplate, this.errors)
    }

    // Use the latest commit to create the check against
    return meteredPlugin(this, () => this.github.repos.listCommits({
      owner: this.repo.owner,
      repo: env.ADMIN_REPO
    })
      .then(commits => {
        return this.github.checks.create(
          {
            owner: this.repo.owner,
            repo: env.ADMIN_REPO,
            name: 'Safe-Settings',
            head_sha: commits.data[0].sha,
            status: 'completed',
            started_at: startTime,
            conclusion,
            completed_at: new Date(),
            output: {
              title: 'Safe-Settings',
              summary,
              text: details.length > 55536 ? `${details.substring(0, 55536)}... (too many changes to report)` : details
            }
          }
        )
      })
      .then(res => {
        this.log.debug(`Created the check for Safe-Settings ${JSON.stringify(res)}`)
      })).catch(e => {
        if (e.status === 404) {
          this.log.error('Admin Repo Not found')
        }
        this.log.error(`Check for Safe-Settings failed with ${JSON.stringify(e)}`)
      })
  }

  logError (msg) {
    this.log.error(msg)
    this.errors.push({
      owner: this.repo.owner,
      repo: this.repo.repo,
      msg,
      plugin: this.constructor.name
    })
  }

  hasError () {
    return !!this.errors.length
  }

  async handleResults () {
    const { payload } = this.context

    // Create a checkrun if not in nop mode
    if (!this.nop) {
      this.log.debug('Not run in nop')
      await this.createCheckRun()
      return
    }

    // remove duplicate rows in this.results
    this.results = this.results.filter((thing, index, self) => {
        return index === self.findIndex((t) => {
          return t.type === thing.type && t.repo === thing.repo && t.plugin === thing.plugin
        })
      })

    let error = false
    // Different logic
    const stats = {
      // noOfReposProcessed: new Map(),
      reposProcessed: {},
      changes: {},
      errors: {}
    }
    /*
    Result fields
    res.type
    res.plugin
    res.repo
    res.endpoint
    res.body
    res.action
    */
    this.results.forEach(res => {
      if (res) {
        stats.reposProcessed[res.repo] = true
        // if (res.action.additions === null && res.action.deletions === null && res.action.modifications === null) {
        //   // No changes
        // } else
        if (res.type === 'ERROR') {
          error = true
          if (!stats.errors[res.repo]) {
            stats.errors[res.repo] = []
          }
          stats.errors[res.repo].push(res.action)
        } else if (!(res.action?.additions === null && res.action?.deletions === null && res.action?.modifications === null)) {
          if (!stats.changes[res.plugin]) {
            stats.changes[res.plugin] = {}
          }
          if (!stats.changes[res.plugin][res.repo]) {
            stats.changes[res.plugin][res.repo] = []
          }
          stats.changes[res.plugin][res.repo].push(`${res.action}`)
        }
      }
    })

    this.log.debug(`Stats ${JSON.stringify(this.results, null, 2)}`)

    const table = `<table>
    <thead>
    <tr>
    <th>Msg</th>
    <th>Plugin</th>
    <th>Repo/Team</th>
    <th>Additions</th>
    <th>Deletions</th>
    <th>Modifications </th>
    </tr>
    </thead>
    <tbody>
    `

    const renderedCommentMessage = await eta.renderString(commetMessageTemplate, stats)

    if (env.CREATE_PR_COMMENT === 'true') {
      const results = this.results.filter(result => !result?.isQuiet)
      const quietResults = this.results.filter(result => result?.isQuiet)

      let summary = `
#### :robot: Safe-Settings config changes detected:

${results.reduce((x, y) => {
        if (!y) {
          return x
        }
        if (y.type === 'ERROR') {
          error = true
          return `${x}
<tr><td> ❗ ${y.action.msg} </td><td> ${y.plugin} </td><td> ${prettify(y.repo)} </td><td> ${prettify(y.action.additions)} </td><td> ${prettify(y.action.deletions)} </td><td> ${prettify(y.action.modifications)} </td><tr>`
        } else if (y.action.additions === null && y.action.deletions === null && y.action.modifications === null) {
          return `${x}`
        } else {
          if (y.action === undefined) {
            return `${x}`
          }
          return `${x}
<tr><td> ✋ </td><td> ${y.plugin} </td><td> ${prettify(y.repo)} </td><td> ${prettify(y.action.additions)} </td><td> ${prettify(y.action.deletions)} </td><td> ${prettify(y.action.modifications)} </td><tr>`
        }
      }, table)}
`
      if (quietResults.length) {
        summary += `
<sub>${quietResults.length} NOOP actions are not shown but are included in the source of this comment</sub>

<!--
${stripAllWhitespace(JSON.stringify(quietResults, null, 2))}
-->
`
      }

      const pullRequest = payload.check_run.check_suite.pull_requests[0]

      await meteredPlugin(this, () => this.github.issues.createComment({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: pullRequest.number,
        body: summary.length > 55536 ? `${summary.substring(0, 55536)}... (too many changes to report)` : summary
      })).catch(e => this.log.error(`Unable to create PR comment: ${e}`))
    }

    const params = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      check_run_id: payload.check_run.id,
      status: 'completed',
      conclusion: error ? 'failure' : 'success',
      completed_at: new Date().toISOString(),
      output: {
        title: error ? 'Safe-Settings Dry-Run Finished with Error' : 'Safe-Settings Dry-Run Finished with success',
        summary: renderedCommentMessage.length > 55536 ? `${renderedCommentMessage.substring(0, 55536)}... (too many changes to report)` : renderedCommentMessage
      }
    }

    this.log.debug(`Completing check run ${JSON.stringify(params)}`)
    await meteredPlugin(this, () => this.github.checks.update(params))
  }

  async loadConfigs (repo) {
    this.subOrgConfigs = await this.getSubOrgConfigs()
    this.repoConfigs = await this.getRepoConfigs(repo)
  }

  async updateOrg () {
    const rulesetsConfig = this.config.rulesets
    if (rulesetsConfig) {
      const RulesetsPlugin = Settings.PLUGINS.rulesets
      return new RulesetsPlugin(this.nop, this.github, this.repo, rulesetsConfig, this.log, this.errors, SCOPE.ORG).sync().then(res => {
        this.appendToResults(res)
      })
    }
  }

  async updateOrgTeams (org, teamSlug, override) {
    const teamConfigs = await this.getTeamConfigs(teamSlug)

    const filter = ({ slug }) => {
      if (this.isRestricted(slug, 'restrictedTeams')) {
        return false
      }

      if (teamSlug && teamSlug !== slug) {
        return false
      }

      return true
    }

    const teams = await ReviewRequestDelegation.find(this.github, org, filter)

    return Promise.all(
      teams.map(entry => {
        const team = {
          slug: entry.slug,
          owner: org
        }

        const rootConfig = this.config.reviewRequestDelegation
        let teamConfig = rootConfig
        const overrideTeamConfig = teamConfigs[`${entry.slug}.yml`]?.reviewRequestDelegation
        if (override) {
          teamConfig = override
        } else if (overrideTeamConfig) {
          teamConfig = this.mergeDeep.mergeDeep({}, rootConfig, overrideTeamConfig)
        }

        return new ReviewRequestDelegation(this.nop, this.github, team, teamConfig, this.log, this.errors)
          .sync(entry)
          .then(res => {
            this.appendToResults(res)
          })
      })
    )
  }

  async updateRepos(repo) {
    this.subOrgConfigs = this.subOrgConfigs || await this.getSubOrgConfigs()
    // Keeping this as is instead of doing an object assign as that would cause `Cannot read properties of undefined (reading 'startsWith')` error
    // Copilot code review would recoommend using object assign but that would cause the error
    let repoConfig = this.config.repository
    if (repoConfig) {
      repoConfig = Object.assign(repoConfig, { name: repo.repo, org: repo.owner })
    }

    const subOrgConfig = this.getSubOrgConfig(repo.repo)

    // If suborg config has been updated then only restrict to the repos for that suborg
    if (this.subOrgConfigMap && !subOrgConfig) {
      this.log.debug(`Skipping... SubOrg config changed but this repo is not part of it. ${JSON.stringify(repo)} suborg config ${JSON.stringify(this.subOrgConfigMap)}`)
      return
    }

    this.log.debug(`Process normally... Not a SubOrg config change or SubOrg config was changed and this repo is part of it. ${JSON.stringify(repo)} suborg config ${JSON.stringify(this.subOrgConfigMap)}`)

    if (subOrgConfig) {
      let suborgRepoConfig = subOrgConfig.repository
      if (suborgRepoConfig) {
        suborgRepoConfig = Object.assign(suborgRepoConfig, { name: repo.repo, org: repo.owner })
        repoConfig = this.mergeDeep.mergeDeep({}, repoConfig, suborgRepoConfig)
      }
    }

    // Overlay repo config
    // RepoConfigs should be preloaded but checking anyway
    const overrideRepoConfig = this.repoConfigs[`${repo.repo}.yml`]?.repository || this.repoConfigs[`${repo.repo}.yaml`]?.repository
    if (overrideRepoConfig) {
      repoConfig = this.mergeDeep.mergeDeep({}, repoConfig, overrideRepoConfig)
    }
    if (repoConfig) {
      try {
        this.log.debug(`found a matching repoconfig for this repo ${JSON.stringify(repoConfig)}`)
        const childPlugins = this.childPluginsList(repo)
        const RepoPlugin = Settings.PLUGINS.repository
        return new RepoPlugin(this.nop, this.github, repo, repoConfig, this.installation_id, this.log, this.errors).sync().then(res => {
          this.appendToResults(res)
          return Promise.all(
            childPlugins.map(([Plugin, config]) => {
              return new Plugin(this.nop, this.github, repo, config, this.log, this.errors).sync()
            }))
        }).then(res => {
          this.appendToResults(res)
        })
      } catch (e) {
        if (this.nop) {
          const nopcommand = new NopCommand(this.constructor.name, this.repo, null, `${e}`, 'ERROR')
          this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
          this.appendToResults([nopcommand])
          // throw e
        } else {
          throw e
        }
      }
    } else {
      this.log.debug(`Didnt find any a matching repoconfig for this repo ${JSON.stringify(repo)} in ${JSON.stringify(this.repoConfigs)}`)
      const childPlugins = this.childPluginsList(repo)
      return Promise.all(childPlugins.map(([Plugin, config]) => {
        return new Plugin(this.nop, this.github, repo, config, this.log, this.errors).sync().then(res => {
          this.appendToResults(res)
        })
      }))
    }
  }


  async updateAll () {
    // this.subOrgConfigs = this.subOrgConfigs || await this.getSubOrgConfigs(this.github, this.repo, this.log)
    // this.repoConfigs = this.repoConfigs || await this.getRepoConfigs(this.github, this.repo, this.log)
    return this.eachRepositoryRepos(this.github, this.log).then(res => {
      this.appendToResults(res)
    })
  }

  getSubOrgConfig (repoName) {
    if (this.subOrgConfigs) {
      for (const pattern of Object.keys(this.subOrgConfigs)) {
        const glob = new Glob(pattern)
        if (glob.test(repoName)) {
          return this.subOrgConfigs[pattern]
        }
      }
    }
    return undefined
  }

  // Remove Org specific configs from the repo config
  returnRepoSpecificConfigs (config) {
    const newConfig = Object.assign({}, config) // clone
    delete newConfig.rulesets
    return newConfig
  }

  childPluginsList (repo) {
    const repoName = repo.repo
    const subOrgOverrideConfig = this.getSubOrgConfig(repoName)
    this.log.debug(`suborg config for ${repoName} is ${JSON.stringify(subOrgOverrideConfig)}`)
    const repoOverrideConfig = this.getRepoOverrideConfig(repoName)
    const overrideConfig = this.mergeDeep.mergeDeep({}, this.returnRepoSpecificConfigs(this.config), subOrgOverrideConfig, repoOverrideConfig)

    this.log.debug(`consolidated config is ${JSON.stringify(overrideConfig)}`)

    const childPlugins = []
    for (const [section, config] of Object.entries(overrideConfig)) {
      const baseConfig = this.config[section]
      if (Array.isArray(baseConfig) && Array.isArray(config)) {
        for (const baseEntry of baseConfig) {
          const newEntry = config.find(e => e.name === baseEntry.name)
          this.validate(section, baseEntry, newEntry)
        }
      } else {
        this.validate(section, baseConfig, config)
      }
      if (section !== 'repositories' && section !== 'repository') {
        // Ignore any config that is not a plugin
        if (section in Settings.PLUGINS) {
          this.log.debug(`Found section ${section} in the config. Creating plugin...`)
          const Plugin = Settings.PLUGINS[section]
          childPlugins.push([Plugin, config])
        }
      }
    }
    return childPlugins
  }

  getRepoOverrideConfig (repoName) {
    return this.repoConfigs[`${repoName}.yml`] || this.repoConfigs[`${repoName}.yaml`] || {}
  }

  validate (section, baseConfig, overrideConfig) {
    const configValidator = this.configvalidators[section]
    if (configValidator) {
      this.log.debug(`Calling configvalidator for key ${section} `)
      try {
        const isValid = configValidator.isValid(overrideConfig, this.github)
        if (!isValid) {
          throw new Error(configValidator.error)
        }
      } catch (error) {
        this.log.error(`Error in calling configvalidator for key ${section} ${error}`)
        throw error
      }
    }
    const overridevalidator = this.overridevalidators[section]
    if (overridevalidator) {
      this.log.debug(`Calling overridevalidator for key ${section} `)
      try {
        const canOverride = overridevalidator.canOverride(baseConfig, overrideConfig, this.github)
        if (!canOverride) {
          throw new Error(overridevalidator.error)
        }
      } catch (error) {
        this.log.error(`Error in calling overridevalidator for key ${section} ${error}`)
        throw error
      }
    }
  }

  isRestricted (name, configKey = 'restrictedRepos') {
    const restricted = this.config[configKey]
    if (!restricted && configKey !== 'restrictedRepos') {
      return false
    }
    // Skip configuring any restricted repos
    if (Array.isArray(restricted)) {
      if (this.includesRepo(name, restricted)) {
        this.log.debug(`Skipping retricted repo ${name}`)
        return true
      } else {
        this.log.debug(`${name} not in ${configKey} ${restricted}`)
        return false
      }
    } else if (Array.isArray(restricted.include)) {
      if (this.includesRepo(name, restricted.include)) {
        this.log.debug(`Allowing ${name} in ${configKey}.include [${restricted.include}]`)
        return false
      } else {
        this.log.debug(`Skipping ${name} not in ${configKey}.include`)
        return true
      }
    } else if (Array.isArray(restricted.exclude)) {
      if (this.includesRepo(name, restricted.exclude)) {
        this.log.debug(`Skipping excluded ${name} in ${configKey}.exclude`)
        return true
      } else {
        this.log.debug(`Allowing ${name} not in ${configKey}.exclude [${restricted.exclude}]`)
        return false
      }
    }
    return false
  }

  includesRepo (repoName, restrictedRepos) {
    return restrictedRepos.map((restrictedRepo) => new Glob(restrictedRepo).test(repoName)).includes(true)
  }

  async eachRepositoryRepos (github, log) {
    log.debug('Fetching repositories')
    return github.paginate('GET /installation/repositories').then(repositories => {
      return Promise.all(repositories.map(repository => {
        if (this.isRestricted(repository.name)) {
          return null
        }

        if (repository.archived) {
          return null
        }

        const { owner, name } = repository
        return this.updateRepos({ owner: owner.login, repo: name })
      })
      )
    })
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async loadConfigMap (params) {
    try {
      this.log.debug(` In loadConfigMap ${JSON.stringify(params)}`)
      const response = await this.github.repos.getContent(params).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(params)} ${e}`)
      })

      if (!response) {
        return []
      }
      // Ignore in case path is a folder
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-directory
      if (Array.isArray(response.data)) {
        // const overrides = new Map()
        const overrides = response.data.map(d => { return { name: d.name, path: d.path } })
        // response.data.forEach(d =>  overrides.set(d.name, d.path))
        return overrides
      }
      // we don't handle symlinks or submodule
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-symlink
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-submodule
      if (typeof response.data.content !== 'string') {
        return
      }
      const yaml = require('js-yaml')
      return yaml.load(Buffer.from(response.data.content, 'base64').toString()) || {}
    } catch (e) {
      if (e.status === 404) {
        return null
      }
      if (this.nop) {
        const nopcommand = new NopCommand('settings', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async getEntityConfigMap (dirName = 'repos') {
    try {
      this.log.debug(`In getEntityConfigMap ${JSON.stringify(this.repo)}`)
      // GitHub getContent api has a hard limit of returning 1000 entries without
      // any pagination. They suggest to use Tree api.
      // https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content

      // get <CONFIG_PATH>/repos directory sha to use in the getTree api
      const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
      const params = Object.assign(repo, { path: path.posix.join(CONFIG_PATH), ref: this.ref })
      const githubDirectoryContentResponse = await this.github.repos.getContent(params).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(params)} ${e}`)
      })

      if (!githubDirectoryContentResponse) {
        throw new Error(`Error reading ${CONFIG_PATH} directory`)
      }

      const githubDirContent = githubDirectoryContentResponse.data
      const repoDirInfo = githubDirContent.filter(dir => dir.name === dirName)[0]
      if (!repoDirInfo) {
        this.log.debug(`No repos directory in the ${env.ADMIN_REPO}/${CONFIG_PATH}`)
        return []
      }

      // read the repo contents using tree
      this.log.debug(`${dirName} directory info ${JSON.stringify(repoDirInfo)}`)
      // const endpoint = `/repos/${this.repo.owner}/${repo.repo}/git/trees/${repoDirInfo.sha}`
      // this.log.debug(`endpoint: ${endpoint}`)
      const treeParams = Object.assign(repo, { tree_sha: repoDirInfo.sha, recursive: 0 })
      const response = await this.github.git.getTree(treeParams).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(this.github.git.getTree.endpoint(treeParams))} ${e}`)
      })

      if (!response || !response.data) {
        this.log.debug(`${dirName} directory exist but reading the tree failed`)
        throw new Error(`exception while reading the ${dirName} directory`)
      }
      // throw error if truncated is true.
      if (response.data.truncated) {
        this.log.debug(`not all ${dirName} files in  directory are read`)
        throw new Error(`not all ${dirName} files in  directory are read`)
      }
      const treeInfo = response.data.tree
      // we emulated the existing loadConfigMap function as is by returning the
      // the same overrides list. This way the overall changes are minimal
      const overrides = treeInfo.map(d => { return { name: d.path, path: path.posix.join(CONFIG_PATH, dirName, d.path) } })
      this.log.debug('Total overrides found in getEntityConfigMap are ' + overrides.length)
      return overrides
    } catch (e) {
      if (this.nop) {
        const nopcommand = new NopCommand('getEntityConfigMap', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async getSubOrgConfigMap () {
    try {
      this.log.debug(` In getSubOrgConfigMap ${JSON.stringify(this.repo)}`)
      const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
      const params = Object.assign(repo, { path: path.posix.join(CONFIG_PATH, 'suborgs'), ref: this.ref })

      const response = await this.loadConfigMap(params)
      return response
    } catch (e) {
      if (this.nop) {
        const nopcommand = new NopCommand('getSubOrgConfigMap', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * If repo param is null load configs for all repos
   * If repo param is null and suborg change, load configs for suborg repos only
   * If repo partam is not null, load the config for a specific repo
   * @param {*} repo repo param
   * @returns repoConfigs object
   */
  async getRepoConfigs (repo) {
    try {
      const overridePaths = await this.getEntityConfigMap()
      const repoConfigs = {}

      for (const override of overridePaths) {
        // Don't load if already loaded
        if (repoConfigs[override.name]) {
          continue
        }
        // If repo is passed get only its config
        // else load all the config
        if (repo) {
          if (override.name === `${repo.repo}.yml` || override.name === `${repo.repo}.yaml`) {
            const data = await this.loadYaml(override.path)
            this.log.debug(`data = ${JSON.stringify(data)}`)
            repoConfigs[override.name] = data
          }
        } else if (this.suborgChange) {
          // If suborg change, only load repos that are part of the suborg
          if (this.getSubOrgConfig(override.name.split('.')[0])) {
            const data = await this.loadYaml(override.path)
            this.log.debug(`data = ${JSON.stringify(data)}`)
            repoConfigs[override.name] = data
          }
        } else {
          const data = await this.loadYaml(override.path)
          this.log.debug(`data = ${JSON.stringify(data)}`)
          repoConfigs[override.name] = data
        }
      }
      this.log.debug(`repo configs = ${JSON.stringify(repoConfigs)}`)
      return repoConfigs
    } catch (e) {
      if (this.nop) {
        this.log.error(e)
        const nopcommand = new NopCommand('getRepoConfigs', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * If repo param is null load configs for all teams
   * If repo partam is not null, load the config for a specific team
   * @param {*} repo repo param
   * @returns repoConfigs object
   */
  async getTeamConfigs (teamSlug) {
    try {
      const overridePaths = await this.getEntityConfigMap('teams')
      const teamConfigs = {}

      for (const override of overridePaths) {
        if (teamConfigs[override.name]) {
          continue
        }
        if (teamSlug) {
          if (override.name === `${teamSlug}.yml`) {
            const data = await this.loadYaml(override.path)
            this.log.debug(`data = ${JSON.stringify(data)}`)
            teamConfigs[override.name] = data
          }
        } else {
          const data = await this.loadYaml(override.path)
          this.log.debug(`data = ${JSON.stringify(data)}`)
          teamConfigs[override.name] = data
        }
      }
      this.log.debug(`repo configs = ${JSON.stringify(teamConfigs)}`)
      return teamConfigs
    } catch (e) {
      if (this.nop) {
        this.log.error(e)
        const nopcommand = new NopCommand('getTeamConfigs', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
      } else {
        throw e
      }
    }
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async getSubOrgConfigs () {
    try {
      // Get all suborg configs even though we might be here becuase of a suborg config change
      // we will filter them out if request is due to a suborg config change
      const overridePaths = await this.getSubOrgConfigMap()
      const subOrgConfigs = {}

      for (const override of overridePaths) {
        const data = await this.loadYaml(override.path)
        this.log.debug(`data = ${JSON.stringify(data)}`)

        if (!data) { return subOrgConfigs }

        subOrgConfigs[override.name] = data
        if (data.suborgrepos) {
          data.suborgrepos.forEach(repository => {
            this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, repository, data)

            // In case support for multiple suborg configs for the same repo is required, merge the configs.
            //
            // Planned for the future to support multiple suborgrepos for the same repo
            //
            // if (existingConfigForRepo) {
            //   subOrgConfigs[repository] = this.mergeDeep.mergeDeep({}, existingConfigForRepo, data)
            // } else {
            //   subOrgConfigs[repository] = data
            // }

            subOrgConfigs[repository] = Object.assign({}, data, { source: override.path })
          })
        }
        if (data.suborgteams) {
          const promises = data.suborgteams.map((teamslug) => {
            return this.getReposForTeam(teamslug)
          })
          await Promise.all(promises).then(res => {
            res.forEach(r => {
              r.forEach(e => {
                this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, e.name, data)
              })
            })
          })
        }
        if (data.suborgproperties) {
          const subOrgRepositories = await this.getSubOrgRepositories(data.suborgproperties)
          subOrgRepositories.forEach(repo =>
            this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, repo.repository_name, data)
          )
        }
      }

      // If this was result of a suborg config change, only return the repos that are part of the suborg config
      if (this.subOrgConfigMap) {
        this.log.debug(`SubOrg config was changed and the associated overridePaths is = ${JSON.stringify(this.subOrgConfigMap)}`)
        // enumerate the properties of the subOrgConfigs object and delete the ones that are not part of the suborg
        for (const [key, value] of Object.entries(subOrgConfigs)) {
          if (!this.subOrgConfigMap.some((overridePath) => {
            return overridePath.path === value.source
          }
          )) {
            delete subOrgConfigs[key]
          }
        }
      }
      return subOrgConfigs
    } catch (e) {
      if (this.nop) {
        const nopcommand = new NopCommand('getSubOrgConfigs', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  storeSubOrgConfigIfNoConflicts (subOrgConfigs, overridePath, repoName, data) {
    const existingConfigForRepo = subOrgConfigs[repoName]
    if (existingConfigForRepo && existingConfigForRepo.source !== overridePath) {
      throw new Error(`Multiple suborg configs for ${repoName} in ${overridePath} and ${existingConfigForRepo?.source}`)
    }
    subOrgConfigs[repoName] = Object.assign({}, data, { source: overridePath })
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async loadYaml(filePath) {
    try {
      const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
      const params = Object.assign(repo, {
        path: filePath,
        ref: this.ref
      })
      const namespacedFilepath = `${this.repo.owner}/${filePath}`;

      // If the filepath already exists in the fileCache, add the etag to the params
      // to check if the file has changed
      if (Settings.fileCache[namespacedFilepath]) {
        params.headers = {
          'If-None-Match': Settings.fileCache[namespacedFilepath].etag
        }
      }

      const response = await this.github.repos.getContent(params).catch(e => {
        if (e.status === 304) {
          this.log.debug(`Cache hit for file ${filePath}`)
          return {
            ...Settings.fileCache[namespacedFilepath],
            cached: true
          }
        }
        this.log.error(`Error getting settings ${e}`)
        throw e
      })

      // Ignore in case path is a folder
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-directory
      if (Array.isArray(response.data)) {
        return null
      }

      // we don't handle symlinks or submodule
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-symlink
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-submodule
      if (typeof response.data.content !== 'string') {
        return
      }

      const content = yaml.load(Buffer.from(response.data.content, 'base64').toString()) || {}

      // Cache the content, as its either new or changed
      if (!response.cached) {
        this.log.debug(`Cache miss for file ${filePath}`)
        Settings.fileCache[namespacedFilepath] = {
          etag: response.headers.etag,
          data: response.data
        }
      }

      return content
    } catch (e) {
      if (e.status === 404) {
        return null
      }
      if (this.nop) {
        const nopcommand = new NopCommand(filePath, this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  appendToResults (res) {
    if (!this.nop || !res) {
      return
    }

    const input = (!Array.isArray(res) && this.isObject(res)) ? [res] : res
    const results = input.flat(3).filter(Boolean)

    this.results = this.results.concat(results)
  }

  async getReposForTeam (teamslug) {
    const options = this.github.rest.teams.listReposInOrg.endpoint.merge({
      org: this.repo.owner,
      team_slug: teamslug,
      per_page: 100
    })
    return this.github.paginate(options)
  }

  async getRepositoriesByProperty (organizationName, propertyFilter) {
    if (!organizationName || !propertyFilter) {
      throw new Error('Organization name and property filter are required')
    }

    const [name] = Object.keys(propertyFilter)
    const value = propertyFilter[name]

    try {
      const query = `props.${name}:${value}`
      const encodedQuery = encodeURIComponent(query)
      const options = this.github.request.endpoint((`/orgs/${organizationName}/properties/values?repository_query=${encodedQuery}`))
      return this.github.paginate(options)
    } catch (error) {
      throw new Error(`Failed to filter repositories for property ${name}: ${error.message}`)
    }
  }


  async getSubOrgRepositories (subOrgProperties) {
    const organizationName = this.repo.owner
    try {
      const repositories = await Promise.all(
        subOrgProperties.map(property =>
          this.getRepositoriesByProperty(organizationName, property)
        )
      )

      // Deduplicate repositories based on repository_name
      const uniqueRepos = repositories
        .flat()
        .reduce((unique, repo) => {
          unique.set(repo.repository_name, repo)
          return unique
        }, new Map())

      const result = Array.from(uniqueRepos.values())

      return result
    } catch (error) {
      throw new Error(`Failed to fetch suborg repositories: ${error.message}`)
    }
  }

  isObject (item) {
    return (item && typeof item === 'object' && !Array.isArray(item))
  }

  isIterable (obj) {
    // checks for null and undefined
    if (obj == null) {
      return false
    }
    return typeof obj[Symbol.iterator] === 'function'
  }
}

function prettify (obj) {
  if (obj === null || obj === undefined) {
    return ''
  }
  return JSON.stringify(obj, null, 2).replaceAll('\n', '<br>').replaceAll(' ', '&nbsp;')
}

Settings.FILE_NAME = path.posix.join(CONFIG_PATH, env.SETTINGS_FILE_PATH)
Settings.FILE_PATH = path.posix.join(CONFIG_PATH, env.SETTINGS_FILE_PATH)
Settings.SUB_ORG_PATTERN = new Glob(`${CONFIG_PATH}/suborgs/*.yml`)
Settings.REPO_PATTERN = new Glob(`${CONFIG_PATH}/repos/*.yml`)

Settings.PLUGINS = {
  repository: require('./plugins/repository'),
  labels: require('./plugins/labels'),
  collaborators: require('./plugins/collaboratorsPartial'),
  teams: require('./plugins/teamsPartial'),
  // milestones: require('./plugins/milestones'),
  branches: require('./plugins/branches'),
  autolinks: require('./plugins/autolinks'),
  // validator: require('./plugins/validator'),
  rulesets: require('./plugins/rulesets'),
  environments: require('./plugins/environments')
  // custom_properties: require('./plugins/custom_properties.js'),
  // variables: require('./plugins/variables')
}

module.exports = Settings

const stripAllWhitespace = (input) => input.replace(/\s/g, '')
