<!-- markdownlint-disable MD023 -->
<!-- markdownlint-disable MD033 -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

-   Added support for forked versions of Rojo that have a different format in their version strings, such as `Rojo (Quenty's Version) 7.3.0`

### Fixed

-   Fixed instances in the explorer view sometimes not being revealed when their file is opened
-   Fixed instances in the explorer view not being revealed when the explorer view initially loads
-   Fixed forcing the explorer view to be focused when selecting instance files in another view (search, native file explorer, ...)

## `0.1.7` - June 30th, 2023

### Added

-   The top-level tree item (usually 'game' / the DataModel) now automatically expands unless using multi-root workspace

## `0.1.6` - June 25th, 2023

### Fixed

-   Fixed instances being revealed in the explorer just by hovering over require links

## `0.1.5` - June 21st, 2023

### Fixed

-   Fixed not being able to open instances created from multiple files - meaning scripts with `.meta.json`, wally packages with a project file pointing to `init.lua`, ...

## `0.1.4` - June 18th, 2023

### Added

-   Following a file link by ctrl/cmd+clicking it or pressing F12 will now also reveal it in the explorer view

### Changed

-   Greatly improved performance of icon pack downloads

## `0.1.3` - May 11th, 2023

### Changed

-   Changed the extension to use the native VSCode filesystem APIs instead of node, which may fix some bugs

## `0.1.2` - May 1st, 2023

### Added

-   Add support for inserting services if the root of the explorer is a DataModel
-   Add support for adding arbitrary classes using `.model.json` files, improved Insert Object dialog

### Changed

-   Made right click context menu items more consistent with the normal file explorer

### Fixed

-   Fix paste action not being available in context menu
-   Fix open file / insert object ordering in context menu not being consistent with regular file explorer

## `0.1.1` - April 28th, 2023

### Added

-   Added icon packs to extension settings
-   Added support for light theme in new icon packs
-   Added "Classic" icon pack which is based on the old Roblox Studio icons

### Changed

-   Improve performance of explorer refreshes & updates
-   Decreased extension size substantially

## `0.1.0` - April 27th, 2023

Initial Release
