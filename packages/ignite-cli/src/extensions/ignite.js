// Steeeeeeeve I'm starting to not love this giant deconstruct - leaving it here to prove why
const { dissoc, merge, pipe, prop, sortBy, propSatisfies, filter, reduce, flatten, map, takeLast, split, replace } = require('ramda')
const { startsWith } = require('ramdasauce')
const exitCodes = require('../lib/exitCodes')
const igniteConfigFilename = `${process.cwd()}/ignite/ignite.json`
const igniteVersion = require('../../package.json').version
const path = require('path')

/**
 * The current executing ignite plugin path.
 */
let pluginPath = null

/**
 * Set the current executing ignite plugin path.
 */
function setIgnitePluginPath (path) { pluginPath = path }

/**
 * Gets the path to the current running ignite plugin.
 */
function ignitePluginPath () { return pluginPath }

/**
 * Adds ignite goodies
 *
 * @return {Function} A function to attach to the context.
 */
function attach (plugin, command, context) {
  const { template, runtime, system, parameters, print, filesystem } = context
  const { error, warning } = print

  // if (command.name === 'new' || (command.name === 'add' && parameters.rawCommand.includes('ignite-basic-structure'))) {
  //   if (filesystem.exists(`${process.cwd()}/ignite`) === 'dir') {
  //     error(`This is already an Ignite project root directory.`)
  //     process.exit(exitCodes.GENERIC)
  //   }
  // } else {
  //   if (filesystem.exists(`${process.cwd()}/ignite`) !== 'dir') {
  //     error(`💩 This is not an Ignite project root directory!`)
  //     process.exit(exitCodes.GENERIC)
  //   }
  // }

  // determine which package manager to use
  const forceNpm = parameters.options.npm

  // you know what?  just turn off yarn for now.
  const useYarn = !forceNpm && context.system.which('yarn')

  /**
   * Finds the gluegun plugins that are also ignite plugins.
   *
   * @returns {Plugin[]} - an array of ignite plugins
   */
  function findIgnitePlugins () {
    return pipe(
      filter(propSatisfies(startsWith('ignite-'), 'name')),
      sortBy(prop('name'))
    )(runtime.plugins)
  }

  /**
   * Reads the contents of the ignite/ignite.json configuration.
   *
   * @return {Object} The configuration.
   */
  function loadIgniteConfig () {
    return filesystem.exists(igniteConfigFilename)
      ? filesystem.read(igniteConfigFilename, 'json') || {}
      : {}
  }

  /**
   * Saves a new ignite config file.
   *
   * @param {Object} config The new configuration object to save.
   */
  function saveIgniteConfig (config = {}) {
    filesystem.write(igniteConfigFilename, config, { jsonIndent: 2 })
  }

  /**
   * Adds a npm-based module to the project.
   *
   * @param {string}  moduleName - The module name as found on npm.
   * @param {Object}  options - Various installing flags.
   * @param {boolean} options.link - Should we run `react-native link`?
   * @param {boolean} options.dev - Should we install as a dev-dependency?
   */
  async function addModule (moduleName, options = {}) {
    const depType = options.dev ? 'as dev dependency' : ''
    const spinner = print.spin(`▸ installing ${print.colors.cyan(moduleName)} ${depType}`)

    // install the module
    if (useYarn) {
      const addSwitch = options.dev ? '--dev' : ''
      await system.run(`yarn add ${moduleName} ${addSwitch}`)
    } else {
      const installSwitch = options.dev ? '--save-dev' : '--save'
      await system.run(`npm i ${moduleName} ${installSwitch}`)
    }
    spinner.stop()

    // should we react-native link?
    if (options.link) {
      try {
        spinner.text = `▸ linking`
        spinner.start()
        await system.spawn(`react-native link ${moduleName}`, { stdio: 'ignore' })
        spinner.stop()
      } catch (err) {
        spinner.fail()
        throw new Error(`Error running: react-native link ${moduleName}.\n${err.stderr}`)
      }
    }
  }

  /**
   * Removes a npm-based module from the project.
   *
   * @param {string}  moduleName - The module name to remove.
   * @param {Object}  options - Various uninstalling flags.
   * @param {boolean} options.unlink - Should we unlink?
   * @param {boolean} options.dev - is this a dev dependency?
   */
  async function removeModule (moduleName, options = {}) {
    print.info(`    ${print.checkmark} uninstalling ${moduleName}`)

    // unlink
    if (options.unlink) {
      print.info(`    ${print.checkmark} unlinking`)
      await system.spawn(`react-native unlink ${moduleName}`, { stdio: 'ignore' })
    }

    print.info(`    ${print.checkmark} removing`)
    // uninstall
    if (useYarn) {
      const addSwitch = options.dev ? '--dev' : ''
      await system.run(`yarn remove ${moduleName} ${addSwitch}`)
    } else {
      const uninstallSwitch = options.dev ? '--save-dev' : '--save'
      await system.run(`npm rm ${moduleName} ${uninstallSwitch}`)
    }
  }

  async function copyBatch (context, jobs, props) {
    // grab some features
    const { template, prompt, filesystem, ignite } = context
    const { confirm } = prompt
    const config = ignite.loadIgniteConfig()

    // read some configuration
    const askToOverwrite = config.askToOverwrite || false

    // If the file exists
    const shouldGenerate = async (target) => {
      if (!askToOverwrite) return true
      if (!filesystem.exists(target)) return true
      return await confirm(`overwrite ${target}`)
    }

    // old school loop because of async stuff
    for (let index = 0; index < jobs.length; index++) {
      // grab the current job
      const job = jobs[index]
      // safety check
      if (!job) continue

      // generate the React component
      if (await shouldGenerate(job.target)) {
        const currentPluginPath = ignitePluginPath()
        await template.generate({
          directory: currentPluginPath && `${currentPluginPath}/templates`,
          template: job.template,
          target: job.target,
          props
        })
        // print.info(`    ${print.checkmark} ${job.target}`)
      }
    }
  }

  /**
   * Generates example screens for in dev screens.
   *
   * @param {Array} files - Array of Screens and properties
   * @param {Object} props - The properties to use for template expansion.
   *
   * example:
   * addScreenExamples([
   *   {title: 'Row Example', screen: 'Row.js', ancillary: ['file1', 'file2']},
   *   {title: 'Grid Example', screen: 'Grid.js', ancillary: ['file']},
   *   {title: 'Section Example', screen: 'Section.js', ancillary: ['file']},
   * ])
   */
  async function addScreenExamples (files, props = {}) {
    const { filesystem, patching, ignite } = context
    const config = ignite.loadIgniteConfig()
    // consider this being part of context.ignite
    const pluginName = takeLast(1, split(path.sep, ignitePluginPath()))[0]

    // currently only supporting 1 form of examples
    if (config.examples === 'classic') {
      const spinner = print.spin(`▸ adding screen examples`)

      // merge and flatten all dem files yo.
      let allFiles = reduce((acc, v) => {
        acc.push(v.screen)
        if (v.ancillary) acc.push(v.ancillary)
        return flatten(acc)
      }, [], files)

      // generate stamped copy of all template files
      const templatePath = ignitePluginPath() ? `${ignitePluginPath()}/templates` : `templates`
      map((fileName) => {
        template.generate({
          directory: templatePath,
          template: `${fileName}.ejs`,
          target: `ignite/Examples/Containers/${pluginName}/${fileName}`,
          props
        })
      }, allFiles)

      // insert screen, route, and buttons in PluginExamples (if exists)
      const destinationPath = `${process.cwd()}/ignite/DevScreens/PluginExamplesScreen.js`
      map((file) => {
        // turn things like "examples/This File-Example.js" into "ThisFileExample"
        // for decent component names
        // TODO: check for collisions in the future
        const exampleFileName = takeLast(1, split(path.sep, file.screen))[0]
        const componentName = replace(/.js|\s|-/g, '', exampleFileName)

        if (filesystem.exists(destinationPath)) {
          // insert screen import
          patching.insertInFile(
            destinationPath,
            'import RoundedButton',
            `import ${componentName} from '../Examples/Containers/${pluginName}/${file.screen}'`
          )

          // insert screen route
          patching.insertInFile(
            destinationPath,
            'screen: PluginExamplesScreen',
            `  ${componentName}: {screen: ${componentName}, navigationOptions: {header: {visible: true}}},`
          )

          // insert launch button
          patching.insertInFile(
            destinationPath,
            'styles.screenButtons',
            `
            <RoundedButton onPress={() => this.props.navigation.navigate('${componentName}')}>
              ${file.title}
            </RoundedButton>`
          )
        } // if
      }, files)

      spinner.stop()
    }
  }

  /**
   * Remove example screens from dev screens.
   *
   * @param {Array} files - Array of Screens and properties
   *
   * example:
   * removeScreenExamples([
   *   {screen: 'Row.js', ancillary: ['file1', 'file2']},
   *   {screen: 'Grid.js', ancillary: ['file']},
   *   {screen: 'Section.js', ancillary: ['file']},
   * ])
   */
  async function removeScreenExamples (files) {
    const { filesystem, patching, ignite } = context
    const config = ignite.loadIgniteConfig()
    // consider this being part of context.ignite
    const pluginName = takeLast(1, split(path.sep, ignitePluginPath()))[0]

    // currently only supporting 1 form of examples
    if (config.examples === 'classic') {
      const spinner = print.spin(`▸ removing screen examples`)

      // merge and flatten all dem files yo.
      let allFiles = reduce((acc, v) => {
        acc.push(v.screen)
        if (v.ancillary) acc.push(v.ancillary)
        return flatten(acc)
      }, [], files)

      // delete all files that were inserted
      map((fileName) => {
        filesystem.removeAsync(`ignite/Examples/Containers/${pluginName}/${fileName}`)
      }, allFiles)

      // delete screen, route, and buttons in PluginExamples (if exists)
      const destinationPath = `${process.cwd()}/ignite/DevScreens/PluginExamplesScreen.js`
      map((file) => {
        // turn things like "examples/This File-Example.js" into "ThisFileExample"
        // for decent component names
        const exampleFileName = takeLast(1, split(path.sep, file.screen))[0]
        const componentName = replace(/.js|\s|-/g, '', exampleFileName)

        if (filesystem.exists(destinationPath)) {
          // remove screen import
          patching.replaceInFile(
            destinationPath,
            `import ${componentName} from '../Examples/Containers/${pluginName}/${file.screen}'`,
            ''
          )

          // remove screen route
          patching.replaceInFile(
            destinationPath,
            `  ${componentName}: {screen: ${componentName}, navigationOptions: {header: {visible: true}}},`,
            ''
          )

          // remove launch button
          patching.replaceInFile(
            destinationPath,
            `<RoundedButton.+${componentName}.+[\\s\\S].+\\s*<\\/RoundedButton>`,
            ''
          )
        } // if
      }, files)

      spinner.stop()
    }
  }

  /**
   * Generates an example for use with the dev screens.
   *
   * @param {string} fileName - The js file to create. (.ejs will be appended to pick up the template.)
   * @param {Object} props - The properties to use for template expansion.
   */
  async function addComponentExample (fileName, props = {}) {
    const { filesystem, patching, ignite } = context
    const config = ignite.loadIgniteConfig()

    // do we want to use examples in the classic format?
    if (config.examples === 'classic') {
      const spinner = print.spin(`▸ adding component example`)

      // generate the file
      const templatePath = ignitePluginPath() ? `${ignitePluginPath()}/templates` : `templates`
      template.generate({
        directory: templatePath,
        template: `${fileName}.ejs`,
        target: `ignite/Examples/Components/${fileName}`,
        props
      })

      // adds reference to usage example screen (if it exists)
      const destinationPath = `${process.cwd()}/ignite/DevScreens/PluginExamplesScreen.js`
      if (filesystem.exists(destinationPath)) {
        patching.insertInFile(destinationPath, 'import ExamplesRegistry', `import '../Examples/Components/${fileName}'`)
      }
      spinner.stop()
    }
  }

  /**
   * Removes the component example.
   */
  function removeComponentExample (fileName) {
    const { filesystem, patching, print } = context
    print.info(`    ${print.checkmark} removing component example`)
    // remove file from Components/Examples folder
    filesystem.remove(`${process.cwd()}/ignite/Examples/Components/${fileName}`)
    // remove reference in usage example screen (if it exists)
    const destinationPath = `${process.cwd()}/ignite/DevScreens/PluginExamplesScreen.js`
    if (filesystem.exists(destinationPath)) {
      patching.replaceInFile(destinationPath, `import '../Examples/Components/${fileName}`, '')
    }
  }

  /**
   * Sets an ignite config setting
   *
   * @param {string} key Key of setting to be defined
   * @param {string} value Value to be set
   */
  function setIgniteConfig (key, value, isVariableName = false) {
    const igniteConfig = loadIgniteConfig()
    igniteConfig[key] = value
    saveIgniteConfig(igniteConfig)
  }

  /**
   * Remove Global Config setting
   *
   * @param {string}  key Key of setting to be removed
   */
  function removeIgniteConfig (key) {
    const igniteConfig = dissoc(key, loadIgniteConfig())
    saveIgniteConfig(igniteConfig)
  }

  /**
   * Sets Debug Config setting
   *
   * @param {string}  key             Key of setting to be defined
   * @param {string}  value           Value to be set
   * @param {bool}    isVariableName  Optional flag to set value as variable name instead of string
   */
  function setDebugConfig (key, value, isVariableName = false) {
    const { patching } = context
    const debugConfig = `${process.cwd()}/App/Config/DebugConfig.js`

    if (!filesystem.exists(debugConfig)) {
      error('No `App/Config/DebugConfig.js` file found in this folder, are you sure it is an Ignite project?')
      process.exit(exitCodes.GENERIC)
    }

    if (patching.isInFile(debugConfig, key)) {
      if (isVariableName) {
        patching.replaceInFile(debugConfig, key, `  ${key}: ${value},`)
      } else {
        patching.replaceInFile(debugConfig, key, `  ${key}: '${value},'`)
      }
    } else {
      if (isVariableName) {
        patching.insertInFile(debugConfig, 'export default {', `  ${key}: ${value},`)
      } else {
        patching.insertInFile(debugConfig, 'export default {', `  ${key}: '${value}',`)
      }
    }
  }

  /**
   * Remove Debug Config setting
   *
   * @param {string}  key Key of setting to be removed
   */
  function removeDebugConfig (key) {
    const { patching } = context
    const debugConfig = `${process.cwd()}/App/Config/DebugConfig.js`

    if (!filesystem.exists(debugConfig)) {
      error('💩 No `App/Config/DebugConfig.js` file found in this folder, are you sure it is an ignite project?')
      process.exit(exitCodes.generic)
    }

    if (patching.isInFile(debugConfig, key)) {
      patching.replaceInFile(debugConfig, key, '')
    } else {
      warning(`Debug Setting ${key} not found.`)
    }
  }

  /**
   * Conditionally inserts a string into a file before or after another string.
   * TODO: Move to infinitered/gluegun eventually? Plugin or core?
   *
   * @param {string}  file            File to be patched
   * @param {Object}  opts            Options
   * @param {string}  opts.before     Insert before this string
   * @param {string}  opts.after      Insert after this string
   * @param {string}  opts.insert     String to be inserted
   * @param {string}  opts.match      Skip if this string exists already
   *
   * @example
   *   patchInFile('thing.js', { before: 'bar', insert: 'foo' })
   *
   */
  function patchInFile (file, opts) {
    const { patching } = context
    if (!patching.isInFile(file, opts.match || opts.insert)) {
      patching.insertInFile(file, opts.before || opts.after, opts.insert, !!opts.after)
    }
  }

  /**
   * Generates a file from a template with support for sporked template detection.
   *
   * @param  {{}} opts Generation options.
   * @return {string}  The generated string.
   */
  async function generate (opts = {}) {
    // checked for a sporked version
    const sporkDirectory = `${filesystem.cwd()}/ignite/Spork/${context.plugin.name}`
    const isSporked = filesystem.exists(`${sporkDirectory}/${opts.template}`)

    // override the directory to point to the spork directory if we found one
    const overrides = isSporked
      ? { directory: sporkDirectory }
      : {}

    // now make the call to the gluegun generate
    return await template.generate(merge(opts, overrides))
  }

  // send back the extension
  return {
    ignitePluginPath,
    setIgnitePluginPath,
    useYarn,
    findIgnitePlugins,
    addModule,
    removeModule,
    copyBatch,
    addComponentExample,
    removeComponentExample,
    addScreenExamples,
    removeScreenExamples,
    loadIgniteConfig,
    saveIgniteConfig,
    setIgniteConfig,
    removeIgniteConfig,
    setDebugConfig,
    removeDebugConfig,
    patchInFile,
    generate,
    version: igniteVersion
  }
}

module.exports = attach
