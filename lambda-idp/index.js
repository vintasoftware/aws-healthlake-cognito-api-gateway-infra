const AWS = require('aws-sdk');
const { userInfo } = require('os');
const cognito = new AWS.CognitoIdentityServiceProvider();

/**
 * SMART on FHIR Identity Provider Lambda
 * This Lambda acts as a bridge between HealthLake SMART on FHIR and Cognito
 */
exports.handler = async (event) => {
  console.log('Event received:', JSON.stringify(event, null, 2));

  try {
    // Check user permissions before proceeding
    const userInfo = await getUserInfo(event);
    const hasPermission = await checkUserPermissions(event, userInfo);
    if (!hasPermission) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: "access_denied",
          error_description: "User does not have permission to perform this operation"
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      };
    }

    // Handle HealthLake system requests based on operationName
    if (event.operationName) {
      console.log('Processing HealthLake operation:', event.operationName);

      switch (event.operationName) {
        case 'CreateResource':
          return handleCreateResource(event, userInfo);
        case 'DeleteResource':
          return handleDeleteResource(event, userInfo);
        case 'ReadResource':
          return handleReadResource(event, userInfo);
        case 'SearchAll':
          return handleSearchAll(event, userInfo);
        case 'SearchWithGet':
          return handleSearchWithGet(event, userInfo);
        case 'SearchWithPost':
          return handleSearchWithPost(event, userInfo);
        case 'StartFHIRExportJobWithPost':
          return handleStartFHIRExportJobWithPost(event, userInfo);
        case 'UpdateResource':
          return handleUpdateResource(event, userInfo);
        default:
          console.log('Unhandled operationName:', event.operationName);
          return {
            statusCode: 400,
            body: JSON.stringify({
              error: "unsupported_operation",
              error_description: `Operation ${event.operationName} is not supported`
            }),
            headers: {
              'Content-Type': 'application/json'
            }
          };
      }
    }

    // Default response for unhandled requests
    console.log('Unhandled request, returning default response');
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "invalid_request",
        error_description: "No valid operationName provided"
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    };
  } catch (error) {
    console.error('Error processing request:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "server_error",
        error_description: "An internal server error occurred"
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    };
  }
};

/**
 * Handles HealthLake SearchAll operations
 */
async function handleSearchAll(event) {
  return forwardRequestToHealthLake(event, userInfo);
}

/**
 * Handles HealthLake SearchWithGet operations
 */
async function handleSearchWithGet(event, userInfo) {
  return forwardRequestToHealthLake(event, userInfo);
}

/**
 * Handles CreateResource operation
 */
async function handleCreateResource(event, userInfo) {
  return forwardRequestToHealthLake(event, userInfo);
}

/**
 * Handles DeleteResource operation
 */
async function handleDeleteResource(event, userInfo) {
  return forwardRequestToHealthLake(event, userInfo);
}

/**
 * Handles ReadResource operation
 */
async function handleReadResource(event, userInfo) {
  return forwardRequestToHealthLake(event, userInfo);
}

/**
 * Handles SearchWithPost operation
 */
async function handleSearchWithPost(event, userInfo) {
  return forwardRequestToHealthLake(event, userInfo);
}

/**
 * Handles StartFHIRExportJobWithPost operation
 */
async function handleStartFHIRExportJobWithPost(event, userInfo) {
  return forwardRequestToHealthLake(event, userInfo);
}

/**
 * Handles UpdateResource operation
 */
async function handleUpdateResource(event, userInfo) {
  return forwardRequestToHealthLake(event, userInfo);
}

/**
 * Utility function to forward requests to HealthLake
 */
async function forwardRequestToHealthLake(event, userInfo) {
  try {
    const { datastoreEndpoint, bearerToken } = event;

    if (!datastoreEndpoint || !bearerToken) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "invalid_request",
          error_description: "Missing datastoreEndpoint or bearerToken"
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      };
    }

    // Calculate timestamp values for JWT-like payload
    const currentTimeInSeconds = Math.floor(Date.now() / 1000);
    const expirationTimeInSeconds = currentTimeInSeconds + 3600; // 1 hour expiration
    
    // Determine the appropriate scope based on user permissions
    const scope = "system/*.*"; // Default to full access for now
    
    // Make sure we have a valid role ARN
    if (!process.env.HEALTHLAKE_ROLE_ARN) {
      console.error('HEALTHLAKE_ROLE_ARN environment variable is not set');
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "server_error",
          error_description: "HealthLake IAM role configuration is missing"
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      };
    }

    console.log(`Using HealthLake execution role: ${process.env.HEALTHLAKE_ROLE_ARN}`);
    
    const response = {
      "authPayload": {
        "iss": process.env.OAUTH2_SERVER_URL || "https://main-oauth2-server-link.com/oauth2/token",
        "aud": datastoreEndpoint,
        "iat": currentTimeInSeconds,
        "nbf": currentTimeInSeconds,
        "exp": expirationTimeInSeconds,
        "isAuthorized": true,
        "scope": scope,
        "sub": userInfo.Username || "anonymous"
      },
      "iamRoleARN": process.env.HEALTHLAKE_ROLE_ARN
    };

    console.log('Forwarding request to HealthLake:', JSON.stringify(response, null, 2));

    return response;
  } catch (error) {
    console.error(`Error handling request to HealthLake:`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "server_error",
        error_description: "An error occurred while processing the request"
      }),
      headers: {
        'Content-Type': 'application/json'
      }
    };
  }
}

/** 
 * Get user info from Cognito based on the bearerToken
 */
async function getUserInfo(event) {
  try {
    const { bearerToken } = event;

    if (!bearerToken) {
      console.error('Missing bearerToken for user info');
      return {};
    }

    // Get user info from Cognito
    const userInfo = await cognito.getUser({
      AccessToken: bearerToken
    }).promise();

    console.log('User info:', userInfo);
    return userInfo;
  } catch (error) {
    console.error('Error getting user info:', error);
    return {};
  }
}

/**
 * Checks user permissions in the Cognito user pool based on operation, policies, datastoreEndpoint, and resource path
 */
async function checkUserPermissions(event, userInfo) {
  try {
    const { operationName, datastoreEndpoint } = event;

    const userGroups = await cognito.adminListGroupsForUser({
      Username: userInfo.Username,
      UserPoolId: process.env.COGNITO_USER_POOL_ID
    }).promise();

    const userGroupsNames = userGroups.Groups.map(group => group.GroupName);

    console.log('User info:', userInfo);
    console.log('User groups:', userGroupsNames);

    // Define policies
    const userId = userInfo.Username;
    const policies = {
      Administrators: ['*'],
      Practitioners: ['Patient.read', 'Patient.write', 'Observation.read', 'Observation.write'],
      Patients: [`Patient.read?patient=${userId}`, `Observation.read?subject=${userId}`]
    };

    // Check if the user has permissions for the operation
    const allowedActions = userGroupsNames.reduce((acc, group) => {
      return [...acc, ...(policies[group] || [])];
    }, []);

    console.log('Allowed actions for user:', allowedActions);

    // If the user is an Administrator, allow all operations
    if (allowedActions.includes('*')) {
      return true;
    }

    const resourceOperationPermissionsMap = {
      Patient: {
        CreateResource: ['Patient.write'],
        DeleteResource: ['Patient.write'],
        ReadResource: ['Patient.read'],
        SearchAll: ['Patient.read'],
        SearchWithGet: ['Patient.read'],
        SearchWithPost: ['Patient.read'],
        UpdateResource: ['Patient.write'],
        StartFHIRExportJobWithPost: ['Patient.write'],
      },
      Observation: {
        CreateResource: ['Observation.write'],
        DeleteResource: ['Observation.write'],
        ReadResource: ['Observation.read'],
        SearchAll: ['Observation.read'],
        SearchWithGet: ['Observation.read'],
        SearchWithPost: ['Observation.read'],
        UpdateResource: ['Observation.write'],
        StartFHIRExportJobWithPost: ['Observation.write'],
      },
    };

    // Get the related resource path from the datastoreEndpoint
    const resourcePath = new URL(datastoreEndpoint).pathname.split('/').pop();
    console.log('Resource path:', resourcePath);

    const requiredPermissions = resourceOperationPermissionsMap[resourcePath][operationName] || [];
    console.log('Required permissions for operation:', requiredPermissions);

    // Check if the user has at least one required permission
    const hasPermission = requiredPermissions.every(permission => {
      // Check if the permission matches the datastoreEndpoint
      const allowedActionsPermissionMatch = allowedActions.filter((action) => (
        action.includes('?') ? 
        action.split('?')[0] === permission 
        : action === permission
      ));

      if (allowedActionsPermissionMatch.length === 0) {
        return false;
      }

      // Check if the permission matches the datastoreEndpoint query parameters
      for (const allowedAction of allowedActionsPermissionMatch) {
        if (allowedAction.includes('?')) {
          const [_, query] = allowedAction.split('?');
          const queryParams = new URLSearchParams(query);
          if (operationName === 'SearchWithGet') {
            const endpointQuery = new URLSearchParams(new URL(datastoreEndpoint).search);
            const queryParamsMatch = queryParams.every((value, key) => (
              endpointQuery.has(key) && endpointQuery.get(key) !== value)
            );
            if (!queryParamsMatch) {
              return false;
            }
          } else if (operationName === 'UpdateResource' || operationName === 'DeleteResource' || operationName === 'ReadResource') {
            const endpointPath = new URL(datastoreEndpoint).pathname;
            const endpointPathMatch = endpointPath.includes(queryParams.get('patient') || queryParams.get('subject'));
            if (!endpointPathMatch) {
              return false;
            }
          }
        }
      }

      return true;
    });

    console.log('Permission check result:', hasPermission);
    return hasPermission;
  } catch (error) {
    console.error('Error checking user permissions:', error);
    return false;
  }
}
