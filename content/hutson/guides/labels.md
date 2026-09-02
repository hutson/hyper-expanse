---
draft: false
title: "Labels"
type: guide
tag: professional
aliases:
  - /guides/labels/
---

# Labels

Many source control platforms, including GitHub and GitLab, have limited issue tracking capabilities, usually leaving you with nothing more than the ability to assign an issue to a milestone, assign the issue to one or more individuals, and lastly, to attach one or more labels.

As a result, labels carry significant importance to communicate information about an issue, such as the component of a project the issue is associated with, the importance, or priority of the issue, what kind of experience may be required to resolve the issue, etc.

Using a consistent set of labels lowers the barriers for members of a community to collaborate across cultural and organizational boundaries. No additional domain knowledge is required when transitioning to a new project, and training resources on proper label management can be shared across the community.

## Name

Label names MUST be understandable on their own, without additional context or training.

Example: `0` where `0` is understood, by convention, or other documentation, to be a bug.

In this example, `0` is not accessible to a member of the community, or third-party contributor, who is not familiar with the existing convention, or who has not read a project’s contributing documentation that lays out the convention.

Instead, use `defect` or `bug`, which are complete English words that communicate meaning on their own.

## Description

Labels MAY have a description attached to provide guidance on the proper use of the label.

A description MUST NOT be used as the sole way to convey meaning of the label name, as the label name MUST be able to stand on its own as described in the section above.

Descriptions MUST be complete sentences. Capitalized and with a period at the end.

Complete, properly formatted, sentences afford easier reading.

## Color

Display color for a label MUST NOT be used to convey information, though they MAY still be used if desired.

Information that is only conveyed through color is a disadvantage for those using an improperly calibrated computer screen, or those with a color vision deficiency.

## Discarded Alterations

Considered, but discarded, was the idea of using categories alongside label names as broad themes in which labels could be bucketed into. Separating labels into categories lowers the barrier to discoverability (if you know the general theme of the label you want, you can filter based on the category).

When using categories, each label would consist of two parts, the category to which the label belongs, and a string consisting of additional human-understandable metadata.

To separate the parts use `::` followed by a space, where there is a space after `::`.

A colon, `::`, would not be used elsewhere in a label.

As an example: `type::defect`

However, after consistent real-world usage, categories simply introduced another layer of complexity to labels, without directly addressing discoverability. At the point you knew which category a label belonged to, you knew which label you needed.

## Terminology

The key words _MUST_, _MUST NOT_, _REQUIRED_, _SHALL_, _SHALL NOT_, _SHOULD_, _SHOULD NOT_, _RECOMMENDED_, _MAY_, and _OPTIONAL_ in this document are to be interpreted as described in [RFC 2119](https://tools.ietf.org/html/rfc2119).
