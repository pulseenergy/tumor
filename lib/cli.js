var fs = require('fs'),
	path = require('path'),
	child_process = require('child_process'),
	async = require('async'),
	_ = require('lodash-node'),
	glob = require('glob'),
	color = require('./color'),
	tumor = require('./tumor'),
	help = require('./help');

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
	} else if (arg === '-j') {
		consumed += 2;
		i++;
		if (/^\d+$/.test(argv[i])) {
			jobs = parseInt(argv[i], 10);
		} else {
			help();
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

if (mode == 'link' || mode == 'status') {
	if (argv.length !== 0) help();
} else if (mode == 'exec') {
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

function shouldLink(url) {
	return _.any(matchers, function (matcher) {
		return matcher.test(url);
	});
}

function readJson(file, cb) {
	fs.readFile(file, function (err, data) {
		if (err) return cb(err);
		try {
			cb(null, JSON.parse(data));
		} catch (e) {
			return cb(new Error('Couldn\'t read ' + file + ' as JSON'));
		}
	});
}

function matchersFromFile(file, cb) {
	var dir = path.dirname(file);
	child_process.exec('git config --get remote.origin.url', { cwd: dir }, function (err, stdout, stderr) {
		if (err) {
			verbose('>>> couldn\'t read git remote in ' + dir + ', continuing');
			return cb();
		}

		var pattern = path.dirname(stdout.trim()),
			also;
		if (/https:\/\/github.com\//.test(pattern)) {
			also = pattern.replace(/https:\/\/github.com\//, 'git@github.com:');
			matchers[also] = new RegExp(also);
		}
		if (/git@github.com:/.test(pattern)) {
			also = pattern.replace(/git@github.com:/, 'https://github.com/');
			matchers[also] = new RegExp(also);
		}
		matchers[pattern] = new RegExp(pattern);
		cb();
	});
}

function projectFromFile(file, cb) {
	readJson(file, function (err, json) {
		if (err) return cb(err);

		var project = projects[json.name] = {
			name: json.name,
			path: path.dirname(path.resolve(file)),
			exists: true,
			deps: []
		};
		_.each(_.extend({}, json.dependencies, json.devDependencies), function (version, name) {
			if (shouldLink(version)) {
				project.deps.push(name);
				if (!projects[name]) {
					projects[name] = {
						name: name,
						url: version,
						path: path.join(dir, tumor.expectedPath(version)),
						exists: false,
						deps: []
					};
				}
			}
		});
		cb(null, project);
	});
}

function cloneProject(project, cb) {
	if (noop) {
		project.missing = true;
	}
	var url = project.url.replace(/^git\+ssh:\/\//, '').replace(/#.*$/, '');
	exec('git', ['clone', url, project.path], cb);
}

function checkDependencies(project, output, cb) {
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
	if (project.installed) {
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
	var ahead, behind;
	async.series([
		function (cb) {
			child_process.exec('git rev-list --count @{u}..', { cwd: project.path }, function (err, stdout, stderr) {
				if (!err) {
					ahead = parseInt(stdout, 10);
				}
				cb(err);
			});
		},
		function (cb) {
			child_process.exec('git rev-list --count ..@{u}', { cwd: project.path }, function (err, stdout, stderr) {
				if (!err) {
					behind = parseInt(stdout, 10);
				}
				cb(err);
			});
		},
		function (cb) {
			if (ahead && behind) {
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
				projectFromFile(path.join(project.path, 'package.json'), cb);
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
		verbose('>>> looking for dependencies matching', _.values(matchers));

		async.each(args, projectFromFile, cb);
	}
];

steps.link = [
	expandProjects(cloneProject),
	eachProject(linkDependencies), // multiple links to the same project shouldn't happen in parallel
	eachProject(installProject, true)
];

steps.exec = [
	expandProjects(function (project, cb) {
		project.missing = true;
		cb();
	}),
	eachProject(execCommand, true)
];

steps.status = [
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

async.waterfall(steps.common.concat(steps[mode]), function (err) {
	if (err) throw err;

	verbose('>>> ended with ' + plural(_.size(projects), 'project') + ' in ' + dir);
});
