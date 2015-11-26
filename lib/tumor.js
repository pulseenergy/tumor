var url = require('url');
var path = require('path');
var hostedGitInfo = require('hosted-git-info');

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
