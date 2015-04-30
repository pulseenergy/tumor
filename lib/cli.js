var fs = require('fs'),
	path = require('path'),
	child_process = require('child_process'),
	async = require('async'),
	_ = require('lodash'),
	glob = require('glob'),
	npa = require('npm-package-arg'),
	ngu = require('normalize-git-url'),
	color = require('./color'),
	tumor = require('./tumor'),
	help = require('./help');

var conf = require('rc')('tumor', { link: { override: {} } });

var verbose = function () {},
	info = function () {
		console.log.apply(console, arguments);
	};

var argv = process.argv.slice(2),
	mode = argv[0],
	noop = false,
	failfast = false,
	jobs = 1;

if (argv.length === 0) help();

var i, consumed = 1;
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
		if ('-j' === arg) {
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
	} else if (mode == 'exec') {
		if (arg == '--fail') {
			failfast = true;
			consumed++;
		} else {
			break;
		}
	}
}

argv = argv.slice(consumed);
if (mode == 'link' || mode == 'status' || mode == 'json' || mode == 'dot') {
	if (argv.length !== 0) help();
} else if (mode == 'exec' || mode == 'deps') {
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
	return count + ' ' + (count != 1 ? word + 's' : word);
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
		verbose('>>> ' + name + " matches");
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

	_.each(project.dependencies, function (version, depName) {
		var depPkgFile = path.join(project.path, "node_modules", depName, "package.json");
		if (!fs.existsSync(depPkgFile)) {
			project.missingDependencies.push(depName);
		}
	});
	return project.missingDependencies;
}

function readDep(project) {
	return function (depName, cb) {
		var depFilePath= path.join(project.path, "node_modules", depName, "package.json");
		readJson(depFilePath, function (err, json) {
			if (err) {
				verbose(">>> dep " + depName + " of " + project.name + " couldn't be read from " + depFilePath);
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
				verbose(">>> dep " + depName + " of " + project.name + " doesn't have a repository specified and won't be considered for linking");
			}

			if (shouldLink(name, repo && repo.spec)) {
				project.deps.push(name);
				if (!projects[name]) {
					projects[name] = {
						name: name,
						path:  path.join(dir, name),
						exists: false,
						repository: repo,
						deps: []
					};
				}
			}
			cb();
		});
	};
}

function readProjectDeps(installMissingDeps) {
	return function (project, cb) {
		if (installMissingDeps) {
			async.whilst(function () {
				return checkIfDepsInstalled(project).length;
			}, _.partial(installProject, project), function (err) {
				if (err) return cb(err);

				async.each(_.keys(project.dependencies), readDep(project), cb);
			});
		} else {
			// don't try to read missing dependencies
			var deps = _.clone(project.dependencies);
			_.each(checkIfDepsInstalled(project), function (missing) {
				delete deps[missing];
			});
			async.each(_.keys(deps), readDep(project), cb);
		}
	};
}


function projectFromFile(file, cb) {
	readJson(file, function (err, json) {
		if (err) return cb(err);

		var project = projects[json.name] = {
			name: json.name,
			path: path.dirname(path.resolve(file)),
			exists: true,
			json: json,
			deps: [],
			repository: json.repository ? npa(json.name + '@' + json.repository.url) : null,
			missingDependencies: [],
			dependencies: _.extend({}, json.dependencies, json.devDependencies)
		};
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
	var clone = ngu(project.repository.spec);
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
		info('>>> npm install for ' + color.name(project.name) + ' skipped because it was the target of a npm link');
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
			var proc = child_process.spawn('git', '-c color.status=always status -s'.split(' '), {
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

function expandProjects(whenMissing) {
	return function (cb) {
		async.until(function () {
			return _.all(projects, function (project) {
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
						readProjectDeps(false)(result, function (err) {
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

steps.common = [
	function (cb) {
		verbose('>>> starting with ' + plural(args.length, 'project') + ' in ' + dir);

		async.each(args, matchersFromFile, cb);
	},
	function (cb) {
		verbose('>>> looking for dependencies matching', Object.keys(matchers));

		async.each(args, projectFromFile, cb);
	}
];

steps.link = [
	eachProject(readProjectDeps(true)),
	expandProjects(cloneProject),
	eachProject(linkDependencies), // multiple links to the same project shouldn't happen in parallel
	eachProject(installProject, true)
];

steps.exec = [
	eachProject(readProjectDeps(false)),
	expandProjects(function (project, cb) {
		project.missing = true;
		cb();
	}),
	eachProject(execCommand, true)
];

steps.status = [
	eachProject(readProjectDeps(false)),
	expandProjects(function (project, cb) {
		project.missing = true;
		cb();
	}),
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
];

steps.deps = [
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
];

steps.json = [
	eachProject(readProjectDeps(false)),
	expandProjects(function (project, cb) {
		project.missing = true;
		cb();
	}),
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
];

steps.dot = [
	eachProject(readProjectDeps(false)),
	expandProjects(function (project, cb) {
		project.missing = true;
		cb();
	}),
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
];

async.waterfall(steps.common.concat(steps[mode]), function (err) {
	if (err) throw err;

	verbose('>>> ended with ' + plural(_.size(projects), 'project') + ' in ' + dir);
});
