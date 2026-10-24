'use strict';

class RecipeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RecipeError';
    this.code = code;
    this.status = status;
  }
}

module.exports = { RecipeError };
