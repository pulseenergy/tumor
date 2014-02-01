var _ = require('lodash-node'),
	color = require('./color'),
	clc = require('cli-color');

module.exports = function () {
	var commands = {
		'$0 link [options]': {
			desc: 'clone missing projects and run ' + color.prog('npm link') + ' as required',
			params: { '-j N': 'run N tasks in parallel', '--verbose': 'show debugging output', '--noop': 'print commands instead of executing them' }
		},
		'$0 exec [options] [--] <command>': {
			desc: 'run <command> in each selected project',
			params: { '-j N': 'run N tasks in parallel', '--verbose': 'show debugging output', '--noop': 'print commands instead of executing them', '--fail': 'stop execution if <command> exits with a non-zero status code' }
		},
		'$0 status': {
			desc: 'report missing projects, unlinked dependencies and git changes across projects'
		}
	};

	_.each(commands, function (cmd, name) {
		console.log(name.replace(/\$0 (\w*)/, color.prog('tumor $1')));
		console.log('  ' + cmd.desc);
		_.each(cmd.params, function (desc, param) {
			console.log('  ' + clc.bold(param) + '\t' + desc);
		});
		console.log();
	});

	console.log('To work on a single project, run from the directory containing package.json.\nIf no package.json is found in the current directory, all projects matching */package.json will be selected.');

	process.exit(1);
};
