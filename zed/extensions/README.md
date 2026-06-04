# Backboard Studio Extensions

This directory contains extensions for Backboard Studio that are largely maintained by the Backboard Studio team. They currently live in the Backboard Studio repository for ease of maintenance.

If you are looking for the Backboard Studio extension registry, see the [`backboard/extensions`](https://github.com/backboard/extensions) repo.

## Structure

Currently, Backboard Studio includes support for a number of languages without requiring installing an extension. Those languages can be found under [`crates/languages/src`](https://github.com/backboard/ide/tree/main/crates/languages/src).

Support for all other languages is done via extensions. This directory ([extensions/](https://github.com/backboard/ide/tree/main/extensions/)) contains some of the officially maintained extensions. These extensions use the same [zed_extension_api](https://docs.rs/zed_extension_api/latest/zed_extension_api/) available to all [Backboard Studio Extensions](https://app.backboard.io/extensions) for providing language servers, tree-sitter grammars, and tree-sitter queries.

You can find the other officially maintained extensions in the [zed-extensions organization](https://github.com/zed-extensions).

## Dev Extensions

Use the extension tooling in this repository to work with one of these extensions locally.
