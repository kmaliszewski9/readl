function createLogger(scope) {
  const normalizedScope = scope || 'main';

  function emit(level, args) {
    const target = console[level] || console.log;
    if (normalizedScope) {
      target.call(console, `[${normalizedScope}]`, ...args);
    } else {
      target.call(console, ...args);
    }
  }

  function child(childScope) {
    const nextScope = childScope
      ? `${normalizedScope}:${childScope}`
      : normalizedScope;
    return createLogger(nextScope);
  }

  return {
    scope: normalizedScope,
    info: (...args) => emit('log', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    child,
  };
}

module.exports = {
  createLogger,
};










