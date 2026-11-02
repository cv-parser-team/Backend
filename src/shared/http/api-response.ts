export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ApiResponse<T> {
  success: true;
  data: T;
  message?: string;
  timestamp: string;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    // Only safe, field-level validation info. Never internal details.
    issues?: ValidationIssue[];
  };
  timestamp: string;
}

export type ApiResult<T> = ApiResponse<T> | ApiErrorResponse;