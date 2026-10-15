import { createApp } from 'vue'
import App from './App.vue'
import './assets/styles'
import { router } from './router'
import { dispatchZtoolsCodeEvent, initZtoolsBaseEventHandler } from '@/events'
// 单独导入注册事件
import './events/allCodeEvent'

/**
 * 将设置插件进入事件分派到本机功能路由。
 * @param action 宿主传入的插件进入参数。
 * @returns 无返回值。
 */
function handlePluginEnter(action: Parameters<typeof dispatchZtoolsCodeEvent>[0]): void {
  // 按功能 code 分派本机行为，缓存视图重新进入时仍使用相同路由入口。
  console.log('[插件事件: onPluginEnter]', action)
  dispatchZtoolsCodeEvent(action, router)
}

// 设置插件仅注册一次进入监听，内部通过统一事件分派。
ztools.onPluginEnter(handlePluginEnter)

ztools.onPluginOut(() => {
  if (router.currentRoute.value.name === 'GeneralSetting') {
    return
  }

  void router.replace({ name: 'GeneralSetting' }).catch((error) => {
    console.error('[插件事件: onPluginOut] 重置设置页路由失败', error)
  })
})

// 检测操作系统并添加类名到 html 元素
function detectOS(): void {
  if (window.ztools.isWindows()) {
    document.documentElement.classList.add('os-windows')
  } else if (window.ztools.isMacOS()) {
    document.documentElement.classList.add('os-mac')
  } else {
    document.documentElement.classList.add('os-linux')
  }
}

// 在应用初始化前检测操作系统
detectOS()

const app = createApp(App)
// 注册路由
app.use(router)

app.mount('#app')

// 注册 ztools 关键字跳转事件
initZtoolsBaseEventHandler()
