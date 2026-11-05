# Changelog

## [0.3.0](https://github.com/dannycalleri/turbo-crawl/compare/v0.2.0...v0.3.0) (2026-11-05)


### Features

* follow a listing page to extract every item and its pagination ([9ed3b0c](https://github.com/dannycalleri/turbo-crawl/commit/9ed3b0cbdd7754bf6bd80f451ae0763ea5968de1))


### Bug Fixes

* keep pagination selectors that match nothing on the authoring page ([45befb7](https://github.com/dannycalleri/turbo-crawl/commit/45befb728e68adc185339772c4dda5aebf27bd5a))

## [0.2.0](https://github.com/dannycalleri/turbo-crawl/compare/v0.1.0...v0.2.0) (2026-11-05)


### ⚠ BREAKING CHANGES

* select templates by content fit, not by URL pattern
* remove the interactive TUI; the CLI always runs headless

### Features

* attr:&lt;name&gt; selectors, clean body text, machine-readable dates ([5af8d61](https://github.com/dannycalleri/turbo-crawl/commit/5af8d6144998b0ab285bc35ea26cec803ca66801))
* concurrent library calls with a page limit and a close that waits ([80c32ca](https://github.com/dannycalleri/turbo-crawl/commit/80c32ca6b988ff76ee34e2987f85658d2d288254))
* honest, configurable user agent ([a453014](https://github.com/dannycalleri/turbo-crawl/commit/a453014e7b06df764ab1caf9e3d498db90ed9a3e))
* library API with createCrawler, extract and links ([f7d04ec](https://github.com/dannycalleri/turbo-crawl/commit/f7d04ec8e24448ef2cb7ac8ceef991d1feac09af))
* one browser session for many pages; record the main response ([8f3f537](https://github.com/dannycalleri/turbo-crawl/commit/8f3f537758345356e307faea56a3fd5890d1ea16))
* recognize listing pages and print their item and pagination links ([690ca2d](https://github.com/dannycalleri/turbo-crawl/commit/690ca2ded9447cf401a55def16220b4c7585def2))
* remove the interactive TUI; the CLI always runs headless ([3cc2cb9](https://github.com/dannycalleri/turbo-crawl/commit/3cc2cb969b614c2332dd11690ceeb58e4224982e))
* respect robots.txt and report policy signals ([e15441a](https://github.com/dannycalleri/turbo-crawl/commit/e15441ae4eaa7361f3a12ab4d42994d4eea73793))
* reuse saved listing templates with no agent call ([57e98e2](https://github.com/dannycalleri/turbo-crawl/commit/57e98e24a48880beed2fa0b01bb1cb27f0ee633c))
* select templates by content fit, not by URL pattern ([cf03619](https://github.com/dannycalleri/turbo-crawl/commit/cf03619c1080bd790aca3f4086156f08a5e92e1f))
* templates keep a list of URL patterns and are named by id ([e8cdfe6](https://github.com/dannycalleri/turbo-crawl/commit/e8cdfe64f166edae4982153829cf36b3013ff6ea))


### Bug Fixes

* name the nearest invalid config file every time ([e004c98](https://github.com/dannycalleri/turbo-crawl/commit/e004c98ede732243d3365f96fea908da76a6ff42))

## 0.1.0

Initial public release.
