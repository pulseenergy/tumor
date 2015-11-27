'use strict';

var chalk = require('chalk');

module.exports = {
	name: chalk.bold.blue,
	prog: function (str) {
		return str.split(' ').map(function (part) { return chalk.underline(part); }).join(' ');
	},
	param: chalk.bold
};
