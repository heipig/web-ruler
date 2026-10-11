import { defineConfig } from 'vite';

// base 用相对路径 './' :
//   GitHub Pages 的仓库站点是 https://<用户>.github.io/<仓库名>/,
//   资源必须在子路径下也能正确解析。相对路径同时适配「项目站点」和
//   「用户站点(根路径)」两种情况,不需要为仓库名改配置。
//   代价:不能使用 history 路由(本项目是单页、无路由,不受影响)。
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    // 关闭 sourcemap:产物要直接发布,不需要额外体积
    sourcemap: false,
  },
  server: {
    host: true,
  },
});