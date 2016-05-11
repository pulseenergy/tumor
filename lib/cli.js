'use strict';

var fs = require('fs');
var path = require('path');
var child_process = require('child_process');
var async = require('async');
var _ = require('lodash');
var glob = require('glob');
var npa = require('npm-package-arg');
var ngu = require('normalize-git-url');
var semver = require('semver');
var color = require('./color');
var tumor = require('./tumor');
var help = require('./help');
var Project = require('./project');

var conf = require('rc')('tumor', { link: { override: {} } });

var verbose = function () {};
var info = function () {
	console.log.apply(console, arguments);
};

var argv = process.argv.slice(2);
var mode = argv[0];
var noop = false;
var failfast = false;
var jobs = 1;
var gitStatusArgs = '-c color.status=always status -s'.split(' ');

if (argv.length === 0) help();

var i;
var consumed = 1;
for (i = 1; i < argv.length; i++) {
	var arg = argv[i];
	if (arg === '--help' || arg === '-h') {
		help();
	} else if (arg === '--verbose') {
		consumed++;
		verbose = info;
	} else if (arg === '--noop') {
		consumed++;
		noop = true;
	} else if (/^-j\d*$/.test(arg)) {
		consumed++;
		if (arg === '-j') {
			if (/^\d+$/.test(argv[i + 1])) {
				consumed++;
				i++;
				jobs = +argv[i];
			} else {
				jobs = 100;
			}
		} else {
			jobs = +arg.substr(2);
		}
	} else if (arg === '--') {
		consumed++;
		break;
	} else if (mode === 'exec') {
		if (arg === '--fail') {
			failfast = true;
			consumed++;
		} else {
			break;
		}
	} else if (mode === 'status') {
		if (arg === '--no-untracked') {
			gitStatusArgs.push('-uno');
			consumed++;
		} else {
			break;
		}
	}
}

argv = argv.slice(consumed);
if (mode === 'link' || mode === 'status' || mode === 'json' || mode === 'dot' || mode === 'intellij') {
	if (argv.length !== 0) help();
} else if (mode === 'exec' || mode === 'deps') {
	if (argv.length === 0) help();
} else {
	help();
}

var args, dir;
if (fs.existsSync('package.json')) {
	args = [ './package.json' ];
	dir = '../';
} else {
	args = glob.sync('*/package.json');
	dir = './';
}
dir = path.join(process.cwd(), dir);

var currentContext;
function contextualInfo(context) {
	return function () {
		if (currentContext !== context) {
			info(context);
			currentContext = context;
		}
		if (arguments.length) {
			info.apply(null, arguments);
		}
	};
}

function plural(count, word) {
	return count + ' ' + (count !== 1 ? word + 's' : word);
}

function exec(cmd, args, cwd, cb) {
	if (cb == null) {
		cb = cwd;
		cwd = undefined;
	}
	if (noop) {
		info('(skipped) ' + cmd + ' ' + args.join(' ') + (cwd == null ? '' : ' [cwd=' + cwd + ']'));
		return cb();
	}
	var proc = child_process.spawn(cmd, args, {
		cwd: cwd,
		stdio: ['ignore', process.stdout, process.stderr]
	});
	proc.on('close', function (code) {
		var e = null;
		if (code !== 0) {
			e = new Error(cmd + ' returned ' + code);
		}
		cb(e);
	});
}

var projects = {};
var matchers = {};

function shouldLink(name, repo) {
	if (conf.link.override[name] !== undefined) {
		var forced = String(conf.link.override[name]) !== 'false';
		verbose('>>> configuration forced ' + name + (forced ? '' : ' not') + ' to match');
		return forced;
	}
	var ok = repo && tumor.matchersFromRemote(repo).some(function (matcher) {
		return matchers[matcher] != null;
	});
	if (ok) {
		verbose('>>> ' + name + ' matches');
	}
	return ok;
}

function readJson(file, cb) {
	fs.readFile(file, function (err, data) {
		if (err) return cb(err);
		var json;
		try {
			json = JSON.parse(data);
		} catch (e) {
			return cb(new Error('Couldn\'t read ' + file + ' as JSON'));
		}
		return cb(null, json);
	});
}

function matchersFromFile(file, cb) {
	var dir = path.dirname(file);
	child_process.exec('git config --get remote.origin.url', { cwd: dir }, function (err, stdout, stderr) {
		if (err) {
			verbose('>>> couldn\'t read git remote in ' + dir + ', continuing');
			return cb();
		}
		tumor.matchersFromRemote(stdout.trim()).forEach(function (m) {
			matchers[m] = true;
		});
		cb();
	});
}

function checkIfDepsInstalled(project) {
	project.missingDependencies = [];
	project.invalidDependencies = [];

	_.each(project.dependencies, function (version, depName) {
		var depPkgFile = path.join(project.path, 'node_modules', depName, 'package.json');
		if (!fs.existsSync(depPkgFile)) {
			project.missingDependencies.push(depName);
		} else if (semver.validRange(version)) {
			var found = JSON.parse(fs.readFileSync(depPkgFile)).version;
			if (!semver.satisfies(found, version)) {
				project.invalidDependencies.push({ name: depName, version: found, required: version });
			}
		}
	});
	return project.missingDependencies;
}

function readDep(project, depName, cb) {
	var depFilePath = path.join(project.path, 'node_modules', depName, 'package.json');
	readJson(depFilePath, function (err, json) {
		if (err) {
			verbose('>>> dep ' + depName + ' of ' + project.name + " couldn't be read from " + depFilePath);
			return cb(err);
		}

		var version = project.dependencies[json.name];
		var name = json.name;
		var arg = npa(name + '@' + version);
		var repo;

		if (arg.type === 'git' || arg.type === 'hosted') {
			repo = arg;
		} else {
			repo = json.repository ? npa(json.name + '@' + json.repository.url) : null;
		}
		if (!repo) {
			verbose('>>> dep ' + depName + ' of ' + project.name + " doesn't have a repository specified and won't be considered for linking");
		}

		if (shouldLink(name, repo && repo.spec)) {
			project.deps.push(name);
			if (!projects[name]) {
				projects[name] = Project.remote(name, path.join(dir, name), repo);
			}
		}
		cb();
	});
}

function readProjectDeps(installMissingDeps) {
	return function (project, cb) {

		function finish() {
			var missing = checkIfDepsInstalled(project);

			// don't try to read missing dependencies
			var deps = _.clone(project.dependencies);
			_.each(missing, function (missing) {
				delete deps[missing];
			});
			async.each(_.keys(deps), _.partial(readDep, project), cb);
		}

		if (installMissingDeps && checkIfDepsInstalled(project).length > 0) {
			installProject(project, function (err) {
				err ? cb(err) : finish();
			});
		} else {
			finish();
		}
	};
}

function projectFromFile(file, cb) {
	readJson(file, function (err, json) {
		if (err) return cb(err);

		var project = projects[json.name] = Project.local(json.name, path.dirname(path.resolve(file)), json);
		cb(null, project);
	});
}

function cloneProject(project, cb) {
	if (noop) {
		project.missing = true;
	}
	if (project.repository == null || project.repository.spec == null) {
		info('can\'t clone ' + project.name + ', no repository specified');
		project.missing = true;
		return cb();
	}
	// prefer to clone with ssh
	var clone = ngu(project.repository.hosted ? project.repository.hosted.sshUrl : project.repository.spec);
	verbose('cloning ' + clone.url + ' into ' + project.path + ' on branch ' + clone.branch);
	exec('git', ['clone', clone.url, project.path], function (err) {
		if (err) {
			return cb(err);
		}
		exec('git', ['checkout', clone.branch], project.path, cb);
	});
}

function checkDependencies(project, output, cb) {
	_.each(project.missingDependencies, function (missingDep) {
		output('   dependency ' + missingDep + ' is not installed');
	});
	_.each(project.invalidDependencies, function (missingDep) {
		output('   dependency ' + missingDep.name + ' version ' + missingDep.version + ' doesn\'t match requested version ' + missingDep.required);
	});
	async.eachSeries(project.deps, function (dep, cb) {
		var dependent = projects[dep];
		var module = path.join(project.path, 'node_modules', dependent.name);
		if (!(fs.existsSync(module) && fs.lstatSync(module).isSymbolicLink())) {
			output('   dependency ' + dependent.name + ' is not linked');
		}
		cb();
	}, cb);
}

function linkDependencies(project, cb) {
	if (project.missing) {
		info('>>> linking modules for ' + color.name(project.name) + ' skipped because it hasn\'t been cloned');
		return cb();
	}
	info('>>> linking modules for ' + color.name(project.name));

	async.eachSeries(project.deps, function (dep, cb) {
		var dependent = projects[dep];
		if (dependent.missing) {
			info('   dependency ' + dependent.name + ' hasn\'t been cloned, skipping npm link');
			return cb();
		}

		var relative = path.relative(project.path, dependent.path);
		var module = path.join(project.path, 'node_modules', dependent.name);
		if (fs.existsSync(module) && fs.lstatSync(module).isSymbolicLink()) {
			return cb();
		}
		dependent.installed = true;
		exec('npm', ['link', relative], project.path, cb);
	}, cb);
}

function installProject(project, cb) {
	if (project.missing) {
		info('>>> npm install for ' + color.name(project.name) + ' skipped because it hasn\'t been cloned');
		cb();
	} else if (project.installed) {
		info('>>> npm install for ' + color.name(project.name) + ' skipped because it has already been done');
		cb();
	} else {
		info('>>> npm install for ' + color.name(project.name));
		project.installed = true;
		exec('npm', ['install'], project.path, cb);
	}
}

function execCommand(project, cb) {
	if (!project.exists) return cb();

	var output = contextualInfo('>>> ' + color.name(project.name));

	if (noop) {
		output();
		return exec(argv[0], argv.slice(1), project.path, cb);
	}

	var proc = child_process.spawn(argv[0], argv.slice(1), {
		cwd: project.path,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	proc.stdout.on('data', function (chunk) {
		output();
		process.stdout.write(chunk);
	});
	proc.stderr.on('data', function (chunk) {
		output();
		process.stderr.write(chunk);
	});
	proc.on('close', function (code) {
		var e = null;
		if (failfast && code !== 0) {
			e = new Error(argv[0] + ' returned ' + code);
		}
		cb(e);
	});
}

function gitStatus(project, output, cb) {
	var ahead, behind, failed;
	async.series([
		function (cb) {
			child_process.exec('git rev-list --count @{u}..', { cwd: project.path }, function (err, stdout, stderr) {
				if (err) {
					failed = err;
				} else {
					ahead = parseInt(stdout, 10);
				}
				cb();
			});
		},
		function (cb) {
			child_process.exec('git rev-list --count ..@{u}', { cwd: project.path }, function (err, stdout, stderr) {
				if (err) {
					failed = err;
				} else {
					behind = parseInt(stdout, 10);
				}
				cb();
			});
		},
		function (cb) {
			if (failed) {
				verbose(failed.message);
			} else if (ahead && behind) {
				output('   has diverged from upstream (' + ahead + ' ahead, ' + behind + ' behind)');
			} else if (ahead) {
				output('   is ' + plural(ahead, 'commit') + ' ahead of upstream');
			} else if (behind) {
				output('   is ' + plural(behind, 'commit') + ' behind upstream');
			}
			var proc = child_process.spawn('git', gitStatusArgs, {
				cwd: project.path,
				stdio: ['ignore', 'pipe', 'pipe']
			});
			proc.stdout.on('data', function (chunk) {
				output('   has uncommitted changes');
				process.stdout.write(chunk);
			});
			proc.stderr.on('data', function (chunk) {
				output();
				process.stderr.write(chunk);
			});
			proc.on('close', function (code) {
				cb();
			});
		}
	], cb);
}

function eachProject(func, parallel) {
	return function (cb) {
		if (parallel) {
			async.eachLimit(_.values(projects), jobs, func, cb);
		} else {
			async.eachSeries(_.values(projects), func, cb);
		}
	};
}

function expandProjects(install, whenMissing) {
	return function (cb) {
		async.until(function () {
			return _.every(projects, function (project) {
				return project.exists || project.missing;
			});
		}, eachProject(function (project, cb) {
			if (project.exists || project.missing) {
				cb();
			} else if (!fs.existsSync(project.path)) {
				whenMissing(project, cb);
			} else {
				var file = path.join(project.path, 'package.json');
				projectFromFile(file, function (err, result) {
					if (err) {
						cb(err);
					} else if (result.name !== project.name) {
						cb(new Error('tried to load ' + project.name + ' from ' + file + ' but instead found ' + result.name));
					} else {
						readProjectDeps(install)(result, function (err) {
							if (err) return cb(err);
							cb(null, result);
						});
					}
				});
			}
		}, true), cb);
	};
}

var steps = {};

steps.initial = [
	function (cb) {
		verbose('>>> starting with ' + plural(args.length, 'project') + ' in ' + dir);

		async.each(args, matchersFromFile, cb);
	},
	function (cb) {
		verbose('>>> looking for dependencies matching', Object.keys(matchers));

		async.each(args, projectFromFile, cb);
	}
];

steps.link = steps.initial.concat([
	eachProject(readProjectDeps(true)),
	expandProjects(!noop, cloneProject),
	eachProject(linkDependencies), // multiple links to the same project shouldn't happen in parallel
	eachProject(installProject, true)
]);

// link is the only operation that will clone new projects
steps.common = steps.initial.concat([
	eachProject(readProjectDeps(false)),
	expandProjects(false, function (project, cb) {
		project.missing = true;
		cb();
	})
]);

steps.exec = steps.common.concat([
	eachProject(execCommand, true)
]);

steps.status = steps.common.concat([
	eachProject(function (project, cb) {
		var output = contextualInfo('>>> ' + color.name(project.name));

		if (project.missing) {
			output('   project is missing');
			cb();
		} else {
			async.series([
				checkDependencies.bind(null, project, output),
				gitStatus.bind(null, project, output)
			], cb);
		}
	}, true)
]);

steps.deps = steps.common.concat([
	eachProject(function (project, cb) {
		var output = contextualInfo('>>> ' + color.name(project.name));
		if (project.missing) {
			output('   project is missing');
			cb();
		} else {
			var targetDependency = argv[1] || argv[0];
			var dependencyVersion = project.dependencies[targetDependency];
			if (dependencyVersion) {
				if (argv[0] === '-u') {
					var targetVersion = argv[2];
					output('Updating ' + targetDependency + ' from: ' + dependencyVersion + ' to: ' + targetVersion);
					if (project.json.dependencies && project.json.dependencies[targetDependency]) {
						project.json.dependencies[targetDependency] = targetVersion;
					}
					if (project.json.devDependencies && project.json.devDependencies[targetDependency]) {
						project.json.devDependencies[targetDependency] = targetVersion;
					}
					fs.writeFileSync(path.join(project.path, 'package.json'), JSON.stringify(project.json, null, '  '), {});
				} else {
					output(targetDependency + ': ' + project.dependencies[targetDependency]);
				}
			}
			cb();
		}
	}, true)
]);

steps.json = steps.common.concat([
	function (cb) {
		console.log(JSON.stringify(_.map(projects, function (project) {
			return {
				name: project.name,
				path: project.path,
				repository: project.repository && project.repository.spec,
				deps: project.deps,
				missing: project.missing
			};
		}), null, '  '));
		cb();
	}
]);

steps.dot = steps.common.concat([
	function (cb) {
		console.log('digraph {');
		_.each(projects, function (project) {
			console.log('\t"' + project.name + '";');
			_.each(project.deps, function (dep) {
				console.log('\t"' + project.name + '" -> "' + dep + '";');
			});
		});
		console.log('}');
		cb();
	}
]);

steps.intellij = steps.common.concat([
	function (cb) {
		function write(filename, content) {
			verbose('writing', filename);
			if (noop) {
				child_process.execSync('diff -N -u -w ' + filename + ' - || true',
					{ input: content, stdio: ['pipe', process.stdout, process.stderr] });
			} else {
				fs.writeFileSync(filename, content);
			}
		}

		var imlTemplate = _.template(fs.readFileSync(path.join(__dirname, 'module-template.iml')));
		var libraryTemplate = _.template(fs.readFileSync(path.join(__dirname, 'library-template.xml')));
		var mappingsTemplate = _.template(fs.readFileSync(path.join(__dirname, 'mappings-template.xml')));

		_.each(projects, function (project) {
			var exclusions = _.map(project.deps, function (dep) {
				return 'node_modules/' + dep + '/node_modules';
			});

			var imlFile = path.join(project.path, project.name + '.iml');
			write(imlFile, imlTemplate({
				name: project.name,
				exclusions: ['.tmp', 'dist', 'app/bower_components'].concat(exclusions)
			}));

			var libraryFile = '.idea/libraries/' + project.name.replace(/[ -]/g, '_') + '_node_modules.xml';
			write(libraryFile, libraryTemplate({
				name: project.name,
				exclusions: exclusions
			}));

		});
		var mappingsFile = '.idea/jsLibraryMappings.xml';
		write(mappingsFile, mappingsTemplate({ projects: projects }));
		cb();
	}
]);

async.waterfall(steps[mode], function (err) {
	if (err) throw err;

	verbose('>>> ended with ' + plural(_.size(projects), 'project') + ' in ' + dir);
});
