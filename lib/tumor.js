var url = require('url'),
	path = require('path'),
	hostedGitInfo = require('hosted-git-info');

exports.expectedPath = function (u) {
	return path.basename(url.parse(u).path, '.git');
};

exports.matchersFromRemote = function (remote) {
	var info = hostedGitInfo.fromUrl(remote);
	var pattern;
	if (info) {
		pattern = info.domain + '/' + info.user;
	} else {
		info = url.parse(remote);
		pattern = url.format({ host: info.host, pathname: info.pathname });
		pattern = pattern.replace(/(^\/+|\/+$)/g, '');
		if (pattern.indexOf('code.google.com') === -1) {
			pattern = path.dirname(pattern);
		}
	}
	return [pattern];
};
