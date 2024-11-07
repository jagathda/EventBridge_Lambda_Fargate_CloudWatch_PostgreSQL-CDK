import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export class EventBridgeLambdaFargateCloudWatchPostgreSqlCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC for ECS and RDS
    const vpc = new ec2.Vpc(this, 'MyVpc', {
      maxAzs: 2,
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'MyCluster', {
      vpc: vpc,
    });

    // Create ECR repository for the container
    // CDK will build and push the image to a CDK-managed ECR repository during the deployment process automatically.
    // No need to manually build or push the image.
    /*const repository = new ecr.Repository(this, 'MyRepo', {
      repositoryName: 'message-logger',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });*/

    // IAM role for ECS task execution
    const ecsTaskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Security group for the RDS PostgreSQL instance
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Allow inbound traffic from Fargate tasks to PostgreSQL',
      allowAllOutbound: true,
    });

    // Security group for the ECS Fargate tasks
    const fargateSecurityGroup = new ec2.SecurityGroup(this, 'FargateSecurityGroup', {
      vpc,
      description: 'Allow traffic from Fargate tasks',
      allowAllOutbound: true,
    });

    // Allow Fargate tasks to access PostgreSQL on port 5432
    dbSecurityGroup.addIngressRule(
      fargateSecurityGroup,
      ec2.Port.tcp(5432), // Allow PostgreSQL traffic
      'Allow PostgreSQL access from Fargate tasks'
    );

    // RDS PostgreSQL instance with the updated security group
    const dbInstance = new rds.DatabaseInstance(this, 'PostgreSQLInstance', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3,
      }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [dbSecurityGroup],  // Attach the RDS-specific security group
      allocatedStorage: 20,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      databaseName: 'mydatabase',
      credentials: rds.Credentials.fromGeneratedSecret('dbadmin'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      publiclyAccessible: false,
    });


    // ECS Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      executionRole: ecsTaskExecutionRole,
    });

    const container = taskDefinition.addContainer('MyContainer', {
      //image: ecs.ContainerImage.fromEcrRepository(repository), // ECS pulls the already-built image from ECR and runs the container
      image: ecs.ContainerImage.fromAsset('./'), // Docker image is built during the CDK deployment
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'MyAppLogs',
        logGroup: new logs.LogGroup(this, 'LogGroup', {
          logGroupName: '/ecs/MyApp',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      memoryLimitMiB: 512,
      cpu: 256,
    });

    container.addEnvironment('PG_HOST', dbInstance.instanceEndpoint.hostname);
    container.addEnvironment('PG_USER', 'dbadmin');
    container.addEnvironment('PG_DB', 'mydatabase');
    container.addEnvironment('PG_PORT', '5432');

    if (dbInstance.secret) {
      container.addSecret('PG_PASSWORD', ecs.Secret.fromSecretsManager(dbInstance.secret, 'password'));
    }

    // Dynamically referencing the first two private subnets in the VPC
    const privateSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds;

    // Lambda function to invoke ECS Task
    const lambdaFunction = new lambda.Function(this, 'EcsInvokerLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs');

        exports.handler = async (event) => {
          const ecs = new ECSClient();
          const params = {
            cluster: process.env.CLUSTER_NAME,
            taskDefinition: process.env.TASK_DEFINITION,
            launchType: 'FARGATE',
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: [process.env.SUBNET_1, process.env.SUBNET_2],
                securityGroups: [process.env.SECURITY_GROUP],
                assignPublicIp: 'DISABLED',
              },
            },
            overrides: {
              containerOverrides: [{
                name: 'MyContainer',
                environment: [
                  { name: 'EVENT_PAYLOAD', value: JSON.stringify(event.detail) },
                  { name: 'EVENT_TYPE', value: event['detail-type'] || 'Unknown' }
                ],
              }],
            },
          };
          try {
            const data = await ecs.send(new RunTaskCommand(params));
            console.log("ECS Task started successfully:", JSON.stringify(data, null, 2));
          } catch (err) {
            console.error("Failed to start ECS task:", err);
          }
        };
      `),
      environment: {
        CLUSTER_NAME: cluster.clusterName,
        TASK_DEFINITION: taskDefinition.taskDefinitionArn,
        SUBNET_1: privateSubnets[0], // Dynamically selected first private subnet
        SUBNET_2: privateSubnets[1], // Dynamically selected second private subnet
        SECURITY_GROUP: fargateSecurityGroup.securityGroupId,
      },
    });

    // Grant Lambda permission to pass the ECS task execution role and task role
    lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'iam:PassRole'],
      resources: [
        taskDefinition.taskDefinitionArn,     // ECS Task Definition
        ecsTaskExecutionRole.roleArn,         // ECS Task Execution Role
        taskDefinition.taskRole?.roleArn      // ECS Task Role (add this line)
      ],
    }));

    // EventBridge rule to invoke Lambda function
    const rule = new events.Rule(this, 'MyEventRule', {
      eventPattern: {
        source: ['custom.my-application'],
        detailType: ['myDetailType'],
      },
    });

    rule.addTarget(new targets.LambdaFunction(lambdaFunction));
  }
}
