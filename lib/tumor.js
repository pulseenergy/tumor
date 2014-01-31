var url = require('url'),
	path = require('path');

exports.expectedPath = function (u) {
	return path.basename(url.parse(u).path, '.git');
};