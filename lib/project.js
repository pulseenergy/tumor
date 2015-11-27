'use strict';

var _ = require('lodash');
var npa = require('npm-package-arg');

function Project(name, path, exists) {
	this.name = name;
	this.path = path;
	this.exists = exists;
	this.deps = [];
}

Project.local = function (name, path, json) {
	var p = new Project(name, path, true);
	p.json = json;
	p.repository = json.repository ? npa(json.name + '@' + json.repository.url) : null;
	p.dependencies = _.extend({}, json.dependencies, json.devDependencies);
	return p;
};

Project.remote = function (name, path, repo) {
	var p = new Project(name, path, false);
	p.repository = repo;
	return p;
};

module.exports = Project;
