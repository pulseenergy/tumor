tumor
=====

tumor is a tool for working with many interlinked npm projects all at once. `npm link` mostly works, but it's missing an easy setup step that clones and links all the relevant projects.

there are [other](http://myrepos.branchable.com/) [tools](https://github.com/pulseenergy/mgit) for working with multiple git repositories at once, but this one knows to work only on the repositories relevant to the task at hand.

install it: `npm install -g tumor`.

then in your messy, interlinked projects: `tumor link`, `tumor exec git pull`, `tumor exec git push`, etc.

`tumor exec` is awfully wordy, so it's aliased to `te`.
