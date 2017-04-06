tumor
=====

tumor is a tool for working with many interlinked npm projects all at once. `npm link` mostly works, but it's missing an easy setup step that clones and links all the relevant projects.

there are [other](http://myrepos.branchable.com/) [tools](https://github.com/pulseenergy/mgit) for working with multiple git repositories at once, but this one knows to work only on the repositories relevant to the task at hand.

install it: `npm install -g tumor`.

then in your messy, interlinked projects: `tumor link`, `tumor exec git pull`, `tumor exec git push`, etc.

intellij users can exclude their module directories with `tumor intellij`.

`tumor exec` is awfully wordy, so it's aliased to `te`.

tumor tries to be smart about which projects should be linked, but you can override its decisions with a `.tumorrc` file placed at the root of your workspace.
```
[link.override]
some-dependency=false
```
