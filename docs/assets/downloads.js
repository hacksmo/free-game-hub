/* 站点的小幅增强：把版本号与下载按钮指向最新 Release。
 *
 * 注意：本仓库是**公开**仓库，GitHub API 可匿名访问，但有速率限制，
 * 且网络不可达时页面必须照常可用。
 * 所以这里不能依赖 API 拉版本号与下载量——页面必须完全静态可用。
 * 这个脚本只做「锦上添花」：能拉到就更新，拉不到就保持 HTML 里写死的值，
 * 绝不阻塞页面、绝不报错。
 */
(function () {
  'use strict'

  var REPO = 'hacksmo/free-game-hub'

  function setText(el, value) {
    if (el && value) el.textContent = value
  }

  function applyRelease(release) {
    if (!release) return
    setText(document.getElementById('ver'), String(release.tag_name || '').replace(/^v/, ''))
    var asset = (release.assets || []).filter(function (a) {
      return /\.apk$/i.test(a.name || '')
    })[0]
    var btn = document.getElementById('dl')
    if (asset && asset.browser_download_url && btn) {
      btn.setAttribute('href', asset.browser_download_url)
    }
  }

  fetch('https://api.github.com/repos/' + REPO + '/releases/latest')
    .then(function (r) { return r.ok ? r.json() : null })
    .then(applyRelease)
    .catch(function () { /* 私有仓库拉不到是常态，静默 */ })
})()
