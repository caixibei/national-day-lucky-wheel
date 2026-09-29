'use strict';

/**
 * 业务异常类型：携带 HTTP 状态码与面向用户的中文提示。
 * 全局错误处理中间件据此返回规范化 JSON，避免向客户端泄漏堆栈等内部细节。
 */
class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} message 面向用户的中文业务提示
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { ApiError };
