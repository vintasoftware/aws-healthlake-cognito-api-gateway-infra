import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as healthlake from 'aws-cdk-lib/aws-healthlake';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

// Create a separate stack just for the Cognito certificate in us-east-1
export class CognitoCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;
  
  constructor(scope: Construct, id: string, props: { 
    authDomainName: string;
    hostedZoneName: string;
    hostedZoneId: string;
  }) {
    super(scope, id, {
      env: { region: 'us-east-1' } // Cognito custom domains require certificate in us-east-1
    });

    // Import the hosted zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      zoneName: props.hostedZoneName,
      hostedZoneId: props.hostedZoneId,
    });

    // Create certificate in us-east-1 region
    this.certificate = new acm.Certificate(this, 'CognitoCertificate', {
      domainName: props.authDomainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
    
    // Output the certificate ARN for cross-stack reference
    new cdk.CfnOutput(this, 'CognitoCertificateArn', { 
      value: this.certificate.certificateArn 
    });
  }
}

export interface HealthlakeCdkStackProps extends cdk.StackProps {
  authDomainName: string;
  apiDomainName: string;
  hostedZoneName: string;
  hostedZoneId: string;
  cognitoCertificateArn?: string; // Optional parameter to import certificate
}

export class HealthlakeCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HealthlakeCdkStackProps) {
    super(scope, id, props);

    // Import existing hosted zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      zoneName: props.hostedZoneName,
      hostedZoneId: props.hostedZoneId,
    });

    // Create ACM certificate for API domain
    const apiCertificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: props.apiDomainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Import Cognito certificate from us-east-1 if provided
    let cognitoCertificate: acm.ICertificate;
    if (props.cognitoCertificateArn) {
      cognitoCertificate = acm.Certificate.fromCertificateArn(
        this, 'ImportedCognitoCertificate', props.cognitoCertificateArn
      );
    }

    // Create Cognito User Pool with custom domain
    const userPool = new cognito.UserPool(this, 'HealthLakeUserPool', {
      userPoolName: 'HealthLakeUserPool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
    });

    // Create users groups for different roles
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'Administrators',
      description: 'Administrators with full access',
    });
    const practitionerGroup = new cognito.CfnUserPoolGroup(this, 'PractitionerGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'Practitioners',
      description: 'Healthcare practitioners',
    });
    const patientGroup = new cognito.CfnUserPoolGroup(this, 'PatientGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'Patients',
      description: 'Patients with access to their own records',
    });

    // Create Cognito App Client
    const userPoolClient = new cognito.UserPoolClient(this, 'HealthLakeUserPoolClient', {
      userPool,
      generateSecret: false,
      authFlows: { userPassword: true },
    });

    // Add domain to Cognito - use either a custom domain or prefix domain based on certificate availability
    let userPoolDomain;
    if (props.cognitoCertificateArn) {
      // Validate that the custom domain is a valid subdomain of the hosted zone
      if (!props.authDomainName.endsWith(`.${hostedZone.zoneName}`)) {
        throw new Error(
          `Invalid authDomainName: ${props.authDomainName}. It must be a subdomain of the hosted zone: ${hostedZone.zoneName}`
        );
      }

      try {
        // Use custom domain if we have a certificate
        userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
          userPool,
          customDomain: {
            domainName: props.authDomainName,
            certificate: cognitoCertificate!,
          },
        });

        // Create Route53 record for the Cognito custom domain
        new route53.ARecord(this, 'CognitoDomainRecord', {
          zone: hostedZone,
          recordName: props.authDomainName,
          target: route53.RecordTarget.fromAlias(
            new route53Targets.UserPoolDomainTarget(userPoolDomain)
          ),
        });
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to create custom domain for Cognito: ${error.message}`);
        }
      }
    }

    // Create IAM role for HealthLake SMART on FHIR operations
    const healthLakeExecutionRole = new iam.Role(this, 'HealthLakeSMARTonFHIRRole', {
      assumedBy: new iam.ServicePrincipal('healthlake.amazonaws.com'),
      description: 'Role that HealthLake SMART on FHIR can assume to perform operations',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonHealthLakeFullAccess')
      ]
    });

    // Add permissions needed for HealthLake operations
    healthLakeExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'healthlake:*',
        'iam:PassRole'
      ],
      resources: ['*']
    }));

    // Create SMART on FHIR Identity Provider Lambda with explicit permissions
    const smartOnFhirLambda = new lambda.Function(this, 'SmartOnFhirIdpLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda-idp'),
      environment: {
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_REGION: this.region,
        HEALTHLAKE_ROLE_ARN: healthLakeExecutionRole.roleArn
      },
      timeout: cdk.Duration.seconds(30),
    });

    // Only use the resource-based policy approach using addPermission
    // This creates the correct resource policy to allow HealthLake to invoke the Lambda
    smartOnFhirLambda.addPermission('AllowHealthLakeToInvokeLambda', {
      principal: new iam.ServicePrincipal('healthlake.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    new cdk.CfnOutput(this, 'SmartOnFhirLambdaArnDebug', {
      value: smartOnFhirLambda.functionArn,
      description: 'Debugging SMART on FHIR Lambda ARN',
    });

    // Grant the Smart on FHIR Lambda access to Cognito
    smartOnFhirLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:GetUser',
        'cognito-idp:ListUsers',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:DescribeUserPool',
        'cognito-idp:DescribeUserPoolClient'
      ],
      resources: [userPool.userPoolArn, `${userPool.userPoolArn}/client/*`],
    }));

    // Create AWS HealthLake Data Store with proper SMART on FHIR metadata configuration
    const healthLakeStore = new healthlake.CfnFHIRDatastore(this, 'HealthLakeStore', {
      datastoreTypeVersion: 'R4',
      datastoreName: 'TestHealthLakeStore',
      identityProviderConfiguration: {
        authorizationStrategy: 'SMART_ON_FHIR_V1',
        fineGrainedAuthorizationEnabled: true,
        idpLambdaArn: smartOnFhirLambda.functionArn,
        metadata: JSON.stringify({
          // Top level required fields
          "authorization_endpoint": "https://api.example.com/authorize",
          "token_endpoint": "https://api.example.com/token",
          "code_challenge_methods_supported": ["S256"],  // Only include S256 method as required
          "capabilities": [
            "launch-standalone",
            "client-confidential-symmetric",
            "context-standalone-patient",
            "permission-offline",
            "permission-patient"
          ],
          // Additional nested fields for completeness
          "access": {
            "access_token_uri": "https://api.example.com/token",
            "authorize_uri": "https://api.example.com/authorize"
          },
          "grant_types_supported": [
            "authorization_code",
            "client_credentials"
          ],
          "rest": [
            {
              "security": {
                "extension": [
                  {
                    "url": "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris",
                    "extension": [
                      {
                        "url": "token",
                        "valueUri": "https://api.example.com/token"
                      },
                      {
                        "url": "authorize",
                        "valueUri": "https://api.example.com/authorize"
                      }
                    ]
                  }
                ]
              }
            }
          ]
        })
      },
    });
    healthLakeStore.node.addDependency(smartOnFhirLambda);

    // Create placeholder for API path integration that will be resolved at deployment time
    const healthLakeFhirEndpoint = `${healthLakeStore.attrDatastoreId}/r4`;
    
    // Define the actual HealthLake service endpoint URL
    const healthLakeApiUrl = `https://healthlake.${this.region}.amazonaws.com`;

    // Create Lambda Authorizer
    const authLambda = new lambda.Function(this, 'AuthLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda-auth'),
      environment: {
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_REGION: this.region,
      },
    });

    // Create API Gateway
    const api = new apigateway.RestApi(this, 'HealthLakeApi', {
      restApiName: 'HealthLake Service',
      description: 'API Gateway for AWS HealthLake',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
      // Enable CloudWatch logging
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ApiAccessLogs', {
            logGroupName: `/aws/apigateway/${this.stackName}/access-logs`,
            retention: logs.RetentionDays.ONE_WEEK
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
      cloudWatchRole: true,
    });

    // Create Lambda Authorizer for API Gateway
    const authorizer = new apigateway.TokenAuthorizer(this, 'LambdaAuthorizer', {
      handler: authLambda,
      identitySource: 'method.request.header.Authorization',
    });

    // Create IAM role for HealthLake access
    const healthLakeRole = new iam.Role(this, 'HealthLakeAPIRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonHealthLakeFullAccess')],
    });

    // Create API Gateway Proxy to HealthLake
    const healthLakeProxy = api.root.addResource('healthlake');
    const proxyResource = healthLakeProxy.addResource('{proxy+}');
    
    // Add proxy method for all HTTP methods - using HTTP integration instead of service integration
    proxyResource.addMethod('ANY', new apigateway.HttpIntegration(`${healthLakeApiUrl}/datastore/${healthLakeFhirEndpoint}/{proxy}`, {
      httpMethod: 'ANY',
      options: {
        credentialsRole: healthLakeRole,
        requestParameters: {
          'integration.request.path.proxy': 'method.request.path.proxy'
        },
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        integrationResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
          },
          {
            statusCode: '400',
            selectionPattern: '4\\d{2}',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
          },
          {
            statusCode: '500',
            selectionPattern: '5\\d{2}',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
          }
        ],
      }
    }), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      requestParameters: {
        'method.request.path.proxy': true
      },
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: '400',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: '500',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        }
      ]
    });

    // Also add a default method to the root healthlake resource for operations not requiring a path
    healthLakeProxy.addMethod('ANY', new apigateway.HttpIntegration(`${healthLakeApiUrl}/datastore/${healthLakeFhirEndpoint}`, {
      httpMethod: 'ANY',
      options: {
        credentialsRole: healthLakeRole,
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        integrationResponses: [
          { statusCode: '200', responseParameters: { 'method.response.header.Access-Control-Allow-Origin': "'*'" } },
          { statusCode: '400', selectionPattern: '4\\d{2}', responseParameters: { 'method.response.header.Access-Control-Allow-Origin': "'*'" } },
          { statusCode: '500', selectionPattern: '5\\d{2}', responseParameters: { 'method.response.header.Access-Control-Allow-Origin': "'*'" } }
        ],
      }
    }), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      methodResponses: [
        { statusCode: '200', responseParameters: { 'method.response.header.Access-Control-Allow-Origin': true } },
        { statusCode: '400', responseParameters: { 'method.response.header.Access-Control-Allow-Origin': true } },
        { statusCode: '500', responseParameters: { 'method.response.header.Access-Control-Allow-Origin': true } }
      ]
    });

    // Grant Lambda access to Cognito
    authLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:GetUser'],
      resources: [userPool.userPoolArn],
    }));

    // Create custom domain for API Gateway
    const apiDomain = new apigateway.DomainName(this, 'ApiDomainName', {
      domainName: props.apiDomainName,
      certificate: apiCertificate,
      endpointType: apigateway.EndpointType.REGIONAL,
    });

    // Create base path mapping
    new apigateway.BasePathMapping(this, 'ApiBasePathMapping', {
      domainName: apiDomain,
      restApi: api,
      stage: api.deploymentStage,
    });

    // Create Route53 records to point to the custom domains
    new route53.ARecord(this, 'ApiDomainRecord', {
      zone: hostedZone,
      recordName: props.apiDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayDomain(apiDomain)
      ),
    });

    // Output API Gateway URL & Cognito Info
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url, description: 'API Gateway URL' });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId, description: 'Cognito User Pool ID' });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId, description: 'Cognito App Client ID' });

    // Output HealthLake Datastore ID to update the metadata manually afterwards
    new cdk.CfnOutput(this, 'HealthLakeDatastoreId', { 
      value: healthLakeStore.attrDatastoreId, 
      description: 'HealthLake Datastore ID for SMART on FHIR configuration' 
    });

    // Output Lambda ARN for manual configuration
    new cdk.CfnOutput(this, 'SmartOnFhirLambdaArn', {
      value: smartOnFhirLambda.functionArn,
      description: 'ARN of the SMART on FHIR Identity Provider Lambda',
    });

    // Output instructions for completing the setup
    new cdk.CfnOutput(this, 'SetupInstructions', {
      value: 'After deployment, update the SMART on FHIR metadata in HealthLake console with the actual datastore ID and Lambda ARN',
      description: 'Post-deployment steps',
    });

    // Output important information
    new cdk.CfnOutput(this, 'ApiDomain', { value: `https://${props.apiDomainName}` });
    if (props.cognitoCertificateArn) {
      new cdk.CfnOutput(this, 'CognitoDomain', { value: `https://${props.authDomainName}` });
    }

    // Output the HealthLake execution role ARN
    new cdk.CfnOutput(this, 'HealthLakeExecutionRoleArn', {
      value: healthLakeExecutionRole.roleArn,
      description: 'ARN of the IAM role that HealthLake can assume',
    });
  }
}