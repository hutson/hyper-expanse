---
draft: true
title: "Continuous Pipeline"
type: guide
tag: professional
aliases:
  - /guides/continuous-pipeline/
---

Applying the concepts of _Continuous Integration_, _Continuous Delivery_, _Continuous Deployment_, and _Continuous Release_ to shipping code in the Node/npm ecosystem.

## Continuous Integration

> The practice of continuously integrating work into a shared SCM branch that is subsequently built. May also be further built upon by building changes in separate branches, and on successfully passing the project's requirements, integrated into the project's shared SCM branch.

Continuous Integration platforms include:
* [GitLab CI](https://about.gitlab.com/features/gitlab-ci-cd/)
* [CircleCI](https://circleci.com/)

## Continuous Delivery

When creating a deliverable, we need to do the following:
* Determine the next appropriate version to release based on unreleased changes (Such as git commit).
* Tag the working directory with a new unique idenfitier (Such as a git tag).
* Generate, and post, release notes of changes included in the new release.

Tools for creating a deliverable:
* [`semantic-release-gitlab`](https://www.npmjs.com/package/semantic-release-gitlab)
* [`semantic-release-github`](https://www.npmjs.com/package/semantic-release-github)
* [`semantic-release`](https://www.npmjs.com/package/semantic-release)
* [`semantic-release-app`](https://github.com/tunnckoCore/semantic-release-app) - A GitHub [app](https://developer.github.com/apps/).
* _No app support exists in GitLab_

Once release notes have been generated on the project's SCM platform we ned to generate publishable artifacts:

**Node/npm**
```bash
npm pack
```

> Generates `<name>-<version>.tgz`.

**Python**
```bash
# ?
```

> Generates ?

Post it to the release notes for the given version release on SCM platform:

```bash
upload-artifact-to-[gitlab/github/etc.] --version=CURRENT_GIT_TAG --file=<FILE NAME>
```

> `upload-artifact-to-gitlab` does not currently exist.

Once a deliverable has been published to the project's SCM platform the next step is to deploy it to a production-like environment in the _Continuous Deployment_ stage.

## Continuous Deployment

> The practice of deploying a deliverable built during the _Continuous Delivery_ stage into a production-like environment for load testing prior to releasing the deployment to accept production traffic under a [Blue/Green](https://martinfowler.com/bliki/BlueGreenDeployment.html) scheme.

Publishing the tagged package to an npm-compatible registry using the build artifact that was uploaded to the release notes for the given version:

**Node/npm**
```bash
npm-publish-git-tag [--tag=next] [--access=<public|restricted>]
```

> `npm-publish-git-tag` does not currently support fetching the build artifact from GitLab for publishing. Instead, `npm-publish-git-tag` simply calls `npm publish` on the current directory, which publishes the current directory, as is, to the npm-compatible registry.

> QUESTION: How do we get, or pass, the desired build artifact to `npm-publish-git-tag` so that we don't need to make it SCM specific?

> `npm-publish-git-tag` pulls git tag from environment using `git` command line tool.

> `npm publish` allow you to pass a tarball file for publishing.

Build artifact is published to the `next` tag, not the `latest` dist-tag. This allows us to meet the requirement that the package be published to a production-like environment, but not directly forced upon downstream consumers.

**Python**
```bash
# ?
```

Once the build artifact has been deployed to a production-like environment, which in this case is just the npm registry under a non-production dist-tag, we need to notify users that they can access the non-production deployment for testing.

```bash
post-notices-to-[gitlab/github/etc.] --stage=deployment --version=CURRENT_GIT_TAG --token=<ENVIRONMENT VARIABLE>
```

> `notify-consumers-of-deployment` does not currently exist.

## Continuous Release

> The practice of switching production traffic to the previously deployed deliverable. This may include setting libraries as `latest` for installation by package managers, or having all new requests to a service begin going to the newly deployed service.

**Node/npm**

Update npm-compatible registry state to point `latest` dist-tag to the latest version of package ready for general release.

```bash
npm dist-tag add <package>@<version> latest
```

Next, once the deployment has been _released_, we need to notify consumers of the general availability of the deployment:

```bash
post-notices-to-[gitlab/github/etc.] --stage=release --version=CURRENT_GIT_TAG --token=<ENVIRONMENT VARIABLE>
```

> `post-notices-to-gitlab` does not currently exist.

`post-notices-to-gitlab` will post comments to issues and merge/pull requests related to the changes introduced in the new release. Comments are posted using the account configured with the provided _token_ argument.

Comments should provide the following information:
* The version released.
* The `dist-tag` associated with the release (in this case `latest`).
* How to install package (`npm install <package>` or `npm install <package>@latest`).
* A link to the release notes on SCM platform.

## Other Continuous Processes

### Distributing Releases Downstream

Using tools, such as `renovate` or `greenkeeper`, submit downstream updates that through the downstream project's review process (perhaps just a branch, or a pull/merge request), and on successful build, automatically accept into  the project.

### Deprecating Unsupported Versions

At some point major versions of a project will not longer receive enhancements, or patches, as development work is focused on the latest major.

In this case, using existing support of the given package manager, all versions not on the actively supported major and minor versions, or patch versions that have been superceeded, should be marked as deprecated, and a notice provided to the user as to the state of their dependency.
