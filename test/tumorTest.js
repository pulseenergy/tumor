var assert = require('assert'),
	tumor = require('../lib/tumor');

describe('tumor', function () {

	describe('expectedPath', function () {

		it('works for git:// urls', function () {
			assert.equal(tumor.expectedPath('git://github.com/pulseenergy/tumor.git'), 'tumor');
		});

		it('works for git:// urls with hash', function () {
			assert.equal(tumor.expectedPath('git://github.com/pulseenergy/tumor.git#master'), 'tumor');
		});

		it('works for git+ssh:// urls with hash', function () {
			assert.equal(tumor.expectedPath('git+ssh://git@github.com:pulseenergy/tumor.git#master'), 'tumor');
		});

	});

});
