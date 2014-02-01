var clc = require('cli-color');

module.exports = {
	name: clc.bold.blueBright,
	prog: function (str) {
		return str.split(' ').map(function (part) { return clc.underline(part); }).join(' ');
	}
};
