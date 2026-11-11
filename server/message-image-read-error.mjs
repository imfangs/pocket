import { AppError } from './store.mjs';

// Permission errors describe an OS access denial, not its cause (for example,
// macOS privacy controls or filesystem permissions). Never expose native paths.
export function messageImageReadError(error) {
  if (error instanceof AppError) return error;
  if (error?.code === 'EPERM' || error?.code === 'EACCES')
    return new AppError('Mac 服务无权读取这张图片，请在电脑上检查文件访问权限', 403);
  return new AppError('图片暂时无法读取', 404);
}
