var assert = require('assert'),
	tumor = require('../lib/tumor');

describe('tumor', function () {

	describe('matchersFromRemote', function () {

		var examples = {
			// random examples taken from my local npm cache
			'git+https://github.com/npm/hosted-git-info.git': 'github.com/npm',
			'git://github.com/domenic/path-is-inside.git': 'github.com/domenic',
			'git:git@github.com:doug-martin/extended.git': 'github.com/doug-martin',
			'git@github.com:C2FO/fast-csv.git': 'github.com/C2FO',
			'http://github.com/ariya/esprima.git': 'github.com/ariya',
			'https://MaxMotovilov@github.com/MaxMotovilov/node-promise.git': 'github.com/MaxMotovilov',
			'https://github.com/LearnBoost/kue.git': 'github.com/LearnBoost',
			'https://ryanmcgrath@github.com/ryanmcgrath/wrench-js.git': 'github.com/ryanmcgrath',

			// non-github, or otherwise suspect
			'git://github.com:mafintosh/tar-stream.git': 'github.com/:mafintosh',
			'git://gitorious.org/buster/buster-core.git': 'gitorious.org/buster',
			'http://www.github.com/wdavidw/node-stream-transform': 'www.github.com/wdavidw',
			'https://code.google.com/p/selenium/': 'code.google.com/p/selenium'
		};

		Object.keys(examples).forEach(function (example) {
			it('handles ' + example, function () {
				assert.deepEqual([examples[example]], tumor.matchersFromRemote(example));
			});
		});

	});

});
