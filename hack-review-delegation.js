const bodyParser = require('body-parser')
const Settings = require('./lib/settings')
const ConfigManager = require('./lib/configManager')

const restoreTimeouts = new Map()

/**
 * Temporary mega hack to disable review delegation for a team and restore it after a specified time.
 * Route to be called from a workflow before creating an automerged PR.
 */
const addDisableReviewDelegationRoute = (robot, router, loadYamlFileSystem) => {
  router.post('/api/disable-review-delegation', bodyParser.json(), async (req, res) => {
    const { teamSlug, restoreSeconds } = req.body

    if (!teamSlug || !restoreSeconds) {
      return res.status(400).json({ error: 'teamSlug and restoreSeconds are required.' })
    }

    let github = await robot.auth()

    const installations = await github.paginate(
      github.apps.listInstallations.endpoint.merge({ per_page: 100 })
    )

    if (!installations.length) {
      return res.status(500).json({ message: 'App installation not found.' })
    }

    const installation = installations[0]
    github = await robot.auth(installation.id)
    const context = {
      payload: {
        installation
      },
      octokit: github,
      log: robot.log,
      repo: () => { return { repo: undefined, owner: installation.account.login } }
    }
    const deploymentConfig = await loadYamlFileSystem()
    const configManager = new ConfigManager(context)
    const runtimeConfig = await configManager.loadGlobalSettingsYaml()
    const config = Object.assign({}, deploymentConfig, runtimeConfig)
    const settings = new Settings(false, context, context.repo(), config)
    await settings.updateOrgTeams(installation.account.login, teamSlug, {
      enabled: false
    })
    robot.log.info(`Review delegation disabled for team: ${teamSlug} for seconds: ${restoreSeconds}`)

    let timeout = restoreTimeouts.get(teamSlug)
    if (timeout) {
      robot.log.info(`Clearing previously scheduled restore delegation for team: ${teamSlug} in org: ${installation.account.login}`)
      clearTimeout(timeout)
      restoreTimeouts.delete(teamSlug)
    }

    timeout = setTimeout(async () => {
      robot.log.info(`Restoring review delegation for team: ${teamSlug}`)
      await settings.updateOrgTeams(installation.account.login, teamSlug)
      restoreTimeouts.delete(teamSlug)
    }, restoreSeconds * 1000)

    restoreTimeouts.set(teamSlug, timeout)

    return res.status(200).json({ message: 'Review delegation disabled' })
  })
}

module.exports = {
  addDisableReviewDelegationRoute
}
