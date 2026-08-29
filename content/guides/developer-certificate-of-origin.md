---
draft: false
title: "Developer Certificate of Origin"
type: guide
---

# Developer Certificate of Origin

All contributors MUST certify they are able and willing to provide their contributions under the terms of a project's license by signing off on a [_Developer Certificate of Origin_](https://developercertificate.org/) (Version 1.1).

For a contributor to certify their ability, and willingness, to meet the requirements of the _Developer Certificate of Origin_ (DCO), the following line must be included as the last line of a commit message for every commit contributed:

```
Signed-off-by: FirstName LastName <email@example.org>
```

To append the `Signed-off-by` line automatically, pass the `-s`, or `--signoff`, flag to `git commit`:

```bash
git commit --signoff
```

Git will use the name and e-mail address configured in the Git configuration file to automatically append the line to the commit message.

## Sign-off

A DCO sign-off MUST be appended to every commit contained in a contribution.

An explicit sign-off is an indication that the contributor has read the DCO and is able, and willing, to provide their contributions under the terms of the project's license.

### Implicit for Some

Some organizations have chosen to make the sign-off process implicit. For those instances it's not necessary to sign-off on individual commits. Instead, the contribution itself is indication that you are making your contribution available under the terms of the project's license.

1. [GitLab has taken the stance](https://gitlab.com/gitlab-org/gitlab-ce/issues/43293#note_90822944) that the act of submitting a contribution is acknowledgement of the DCO.

Since a sign-off is merely appended to each commit, an explicit sign-off, while not required by these organizations, may still be a good idea to avoid any later confusion by yourself, or the project, as to whether the contributions were intentionally contributed under the terms of the project's license. [CITATION NEEDED]

### Apache-2.0 Has That Requirement Already

> This section only applies if a project is using the Apache-2.0 license.

While the [Apache-2.0 license](https://www.apache.org/licenses/LICENSE-2.0.html) has _Clause 5_, which states a contribution, unless stated otherwise, `shall be under the terms and conditions of this License`, it's not apparent that the contribution triggers that clause or otherwise triggers the license [CITATION NEEDED].

Therefore, an explicit sign-off protects the project by ensuring there's evidence a contributor agreed to make their contribution under the terms of the project's license [2][3].

## An Alternative to Contributor License Agreement

As pointed out by Richard Fontana in his article, [_CLA Problems_](https://opensource.com/article/19/2/cla-problems), there are arguments in favor of Contributor License Agreements. Those arguments, however, may not be fully justified, and the cost of enforcing a CLA may outweigh any value from the risk mitigated by that CLA.

## Other Users of DCO

- [Eclipse Foundation](https://www.eclipse.org/legal/DCO.php).
- [Linux Kernel](https://elinux.org/Developer_Certificate_Of_Origin).
- [GitLab](https://about.gitlab.com/press/releases/2017-11-01-gitlab-transitions-contributor-license.html)

## References

1. [Developer Certificate](https://developercertificate.org/)
2. [Intent to adopt the Apache License 2.0 for Scala](https://www.scala-lang.org/news/license-change.html)
3. [The most powerful contributor agreement](https://lwn.net/Articles/592503/)
