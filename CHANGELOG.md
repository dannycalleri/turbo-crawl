# Changelog

## [0.4.0](https://github.com/dannycalleri/turbo-crawl/compare/v0.3.0...v0.4.0) (2026-11-11)


### Features

* ask the agent for a css selector when an authored template has none ([58430cb](https://github.com/dannycalleri/turbo-crawl/commit/58430cbbd78badc8d9e33e31297a0ee69fb18ecb))
* download Chromium on the first run when it is missing, with progress on stderr ([830339f](https://github.com/dannycalleri/turbo-crawl/commit/830339f6fcdc9a0c651eecc5895ffabc96c600fe))
* let a fitting listing beat a stale result, and always ask for the page kind ([014a533](https://github.com/dannycalleri/turbo-crawl/commit/014a5337f7fa666152017711cf6e5209c36e6b1e))
* let the agent propose the listing and item URL patterns ([3adfb88](https://github.com/dannycalleri/turbo-crawl/commit/3adfb881289a9859a6f0edec372fbaf7b06658eb))
* let the agent propose the URL pattern when it authors a template ([d2a04a5](https://github.com/dannycalleri/turbo-crawl/commit/d2a04a5ba9fcac44846a9f0575d4b908f38b781e))
* load old pattern lists merged ([9cd5f61](https://github.com/dannycalleri/turbo-crawl/commit/9cd5f6180ffe2798f99df09fd13465e6f138fdee))
* match URLs against stored patterns instead of comparing pattern strings ([89081cf](https://github.com/dannycalleri/turbo-crawl/commit/89081cfa681b6d3a7961d4adf1c68ae8e9f1bdaa))
* record the per-URL pattern after a fit, merge and cap the list ([2fda0ea](https://github.com/dannycalleri/turbo-crawl/commit/2fda0eac780ed62392cfa6ee150ba70fad7a98af))
* report the stored pattern that matches a page as its urlPattern ([bf539df](https://github.com/dannycalleri/turbo-crawl/commit/bf539df27cfe905ac3efb93a19c58ac0bf61c3bf))


### Bug Fixes

* do not ask for the page kind on a URL that matches a stored item pattern ([84d8a04](https://github.com/dannycalleri/turbo-crawl/commit/84d8a04c98da0a4fe37953197762c558c7aabbbb))
* do not widen patterns that already have placeholders when a file loads ([f98ed97](https://github.com/dannycalleri/turbo-crawl/commit/f98ed971b3f1395840bc461afa3ddb2d4ae929d9))
* keep a colon in a literal URL segment from reading as a placeholder ([ce41e53](https://github.com/dannycalleri/turbo-crawl/commit/ce41e53bf0ed4c2602d9d5b6364441f274a73a6f))
* keep an underscore after a URL placeholder as literal text ([6e0c7e1](https://github.com/dannycalleri/turbo-crawl/commit/6e0c7e1c4111d5470c7d52b7e5830275202da7b7))
* keep item patterns off the listing's own pages ([e4e39d5](https://github.com/dannycalleri/turbo-crawl/commit/e4e39d5c2a30d0e5aee2836fcca28c088518d678))
* let a template fit when a css selector confirms a JSON-LD value ([c641946](https://github.com/dannycalleri/turbo-crawl/commit/c6419465f8eae86ffc5dcbc9fb6075627476cffe))
* quote the item pattern that failed in the listing repair round ([20e71eb](https://github.com/dannycalleri/turbo-crawl/commit/20e71ebfaa117498c48604fbb18e10e5c5c8d9d1))
* read the id attribute when outlining a page, not element.id ([3c79ab4](https://github.com/dannycalleri/turbo-crawl/commit/3c79ab45740064b7944f3b7b16020f5466b9628c))
* require Playwright 1.60 and download only the headless shell ([1f866a0](https://github.com/dannycalleri/turbo-crawl/commit/1f866a0927419d00d5059a8657dea3a7a969f159))
* treat double-hyphen and percent-encoded slugs as slugs in URL patterns ([a688c37](https://github.com/dannycalleri/turbo-crawl/commit/a688c379721b4ffbe1ef8d03d5f1526186f434dc))

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
