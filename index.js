#!/usr/bin/env node

const Liftoff = require('liftoff');
const interpret = require('interpret');
const color = require('colorette');
const commander = require('commander');
const path = require('path');
const argv = require('getopts')(process.argv.slice(2));
const sqlFormatter = require('sql-formatter');
const {
    mkConfigObj,
    resolveEnvironmentConfig,
    exit,
    success,
    checkLocalModule,
} = require('knex/bin/utils/cli-config-utils');
const Promise = require('bluebird');
const mockDb = require("mock-knex");

async function openKnexfile(configPath) {
    let config = require(configPath);
    if (typeof config  === 'function') {
        config = await config();
    }

    // FYI: By default, the extension for the migration files is inferred
    //      from the knexfile's extension. So, the following lines are in
    //      place for backwards compatibility purposes.
    config.ext = config.ext || path.extname(configPath).replace('.', '');

    return config;
}

async function initKnex(env, opts) {
    checkLocalModule(env);
    if (process.cwd() !== env.cwd) {
        process.chdir(env.cwd);
        console.log('Working directory changed to', color.magenta(env.cwd));
    }
    env.configuration = env.configPath ? await openKnexfile(env.configPath) : mkConfigObj(opts);
    const resolvedConfig = resolveEnvironmentConfig(opts, env.configuration);
    return require('knex')(resolvedConfig);
}

function invoke(env) {
    env.modulePath = env.modulePath || env.knexpath || process.env.KNEX_PATH;
    commander.option('--rollback', 'Show queries that would perform a rollback.');
    commander.parse(process.argv);
    const opts = commander.opts();
    const isRollBack = opts.rollback === true;
    initKnex(env, opts)
        .then(async (knex) => {
            let isMocked = false;
            let allQueries = [];
            knex.on('query', query => {
                let sql = query.sql.trim();
                if (sql.substr(-1) !== ';') {
                    sql += ';';
                }
                if (sql.includes('create table')) {
                    allQueries.push(sqlFormatter.format(sql));
                } else if (!sql.startsWith('select')) {
                    allQueries.push(sql);
                }
                // select queries run first to see what migrations have already been run
                if (!isMocked && !sql.startsWith('select')) {
                    isMocked = true;
                    mockDb.mock(knex);
                }
            });

            const [completed, newMigrations] = await knex.migrate.list();
            const migrations = isRollBack ? [completed.pop()] : newMigrations.map(migration => migration.file);
            const migrationType = isRollBack ? 'down' : 'up';
            allQueries.push('');
            allQueries.push(`-- Queries to run for ${migrations.length} migration${migrations.length === 1 ? '' : 's'}...`);
            allQueries.push('');
            for (const migration of migrations) {
                const file = `${process.cwd()}/${knex.migrate.config.directory}/${migration}`;
                allQueries.push(`-- Migration: ${knex.migrate.config.directory}/${migration}`);
                let queries = require(file)[migrationType](knex, Promise);
                await queries;
            }
            allQueries.push('');
            success(allQueries.join('\n'));
        })
        .catch(exit);
}

const cli = new Liftoff({
    name: 'knex',
    extensions: interpret.jsVariants,
    v8flags: require('v8flags'),
    moduleName: require('./package.json').name,
});


cli.launch(
    {
        configPath: argv.knexfile,
        require: argv.require,
        completion: argv.completion,
    },
    invoke
);